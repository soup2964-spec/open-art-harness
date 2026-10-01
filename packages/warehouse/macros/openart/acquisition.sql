{#-
  Point-in-time acquisition channel. Emits CTEs (to embed in a WITH list after the anchors CTE)
  ending in `<prefix>_acquisition`: one row per anchor_key with the channel as it was KNOWN at
  the anchor, i.e. from click ids and UTMs whose known_at is before (op '<') or at (op '<=')
  anchor_at. Nothing learned after the anchor can leak in:
    paid click  = the most recent click id known at the anchor (ties: store before Amplitude,
                  then key precedence), mapped by seeds/click_id_platforms.csv
    else UTMs   = first-touch UTMs known at the anchor (tolt/affiliate -> affiliate, paid media
                  -> paid_other, any other source -> referral_other)
    else        = organic
  The anchors CTE must have columns anchor_key, user_id, anchor_at.
  Also returned: the known_at of the click and of the UTMs used (for the point-in-time tests).
-#}
{% macro acquisition_as_of_ctes(anchors, op='<=', prefix='pit') -%}
{{ prefix }}_click_per_key as (

    -- per key: the store's most recent value known at the anchor, else Amplitude's first touch
    select *
    from (
        select
            a.anchor_key,
            c.click_id_key,
            c.platform,
            c.acquisition_channel,
            c.precedence,
            c.click_id_created_at,
            c.known_at,
            row_number() over (
                partition by a.anchor_key, c.click_id_key
                order by c.source_priority, c.click_id_created_at desc, c.click_id_value
            ) as key_rank
        from {{ anchors }} as a
        inner join {{ ref('int_user__click_ids') }} as c
            on c.user_id = a.user_id
           and c.known_at {{ op }} a.anchor_at
    ) as ranked
    where key_rank = 1

),

{{ prefix }}_click as (

    -- across keys: the most recent click (ties: key precedence)
    select *
    from (
        select
            *,
            row_number() over (partition by anchor_key order by click_id_created_at desc, precedence, click_id_key) as click_rank
        from {{ prefix }}_click_per_key
    ) as ranked
    where click_rank = 1

),

{{ prefix }}_click_flags as (

    select
        a.anchor_key,
        {% for key in var('click_id_keys') -%}
        max(case when c.click_id_key = '{{ key }}' then 1 else 0 end) = 1 as has_{{ key }}{% if not loop.last %},{% endif %}
        {% endfor %}
    from {{ anchors }} as a
    inner join {{ ref('int_user__click_ids') }} as c
        on c.user_id = a.user_id
       and c.known_at {{ op }} a.anchor_at
    group by a.anchor_key

),

{{ prefix }}_utm as (

    select
        anchor_key,
        max(case when utm_key = 'utm_source' then utm_value end) as utm_source,
        max(case when utm_key = 'utm_medium' then utm_value end) as utm_medium,
        max(case when utm_key = 'utm_campaign' then utm_value end) as utm_campaign,
        max(known_at) as utm_known_at
    from (
        select
            a.anchor_key,
            u.utm_key,
            u.utm_value,
            u.known_at,
            row_number() over (partition by a.anchor_key, u.utm_key order by u.source_priority, u.known_at) as utm_rank
        from {{ anchors }} as a
        inner join {{ ref('int_user__utm') }} as u
            on u.user_id = a.user_id
           and u.known_at {{ op }} a.anchor_at
    ) as ranked
    where utm_rank = 1
    group by anchor_key

),

{{ prefix }}_acquisition as (

    select
        a.anchor_key,
        coalesce(
            pc.acquisition_channel,
            case
                when lower(pu.utm_source) = 'tolt' or lower(pu.utm_medium) = 'affiliate' then 'affiliate'
                when lower(pu.utm_medium) in ('cpc', 'ppc', 'paid', 'paid_social', 'paidsocial', 'display', 'influencer') then 'paid_other'
                when pu.utm_source is not null then 'referral_other'
                else 'organic'
            end
        ) as acquisition_channel,
        pc.platform as acquisition_platform,
        pc.click_id_key as acquisition_click_id_key,
        pc.click_id_created_at as acquisition_click_at,
        pc.known_at as acquisition_click_known_at,
        pu.utm_source,
        pu.utm_medium,
        pu.utm_campaign,
        pu.utm_known_at,
        {% for key in var('click_id_keys') -%}
        coalesce(pf.has_{{ key }}, false) as has_{{ key }}{% if not loop.last %},{% endif %}
        {% endfor %}
    from {{ anchors }} as a
    left join {{ prefix }}_click as pc on pc.anchor_key = a.anchor_key
    left join {{ prefix }}_utm as pu on pu.anchor_key = a.anchor_key
    left join {{ prefix }}_click_flags as pf on pf.anchor_key = a.anchor_key

)
{%- endmacro %}
