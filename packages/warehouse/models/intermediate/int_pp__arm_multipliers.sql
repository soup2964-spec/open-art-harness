-- Arm effects the first 24 hours cannot show (e.g. output quality of the default video model),
-- per FIT (int_pp__fit_sets). OFF by default (var pp_use_arm_calibration = false: the 24h score is
-- signals-only); computed anyway so the backtest can compare both variants.
--
-- ML review 4 ("noise and circular", 16-37 conversions per arm), two changes:
--   cross-fitting   a user in fold k is scored with the xf<k> fit, which never saw that user, so
--                   an arm's predicted mean is not pulled towards its own realised mean
--   EB shrinkage    per fit and flag, towards "no effect", by how much the arms differ BEYOND noise:
--                     r_a = ln((O_a + 0.5) / (E_a + 0.5))    O = conversions after 24h among the arm's
--                                                            matured unpaid users, E = their segment rates
--                     v_a = 1 / (O_a + 0.5)                  sampling variance of r_a (Poisson)
--                     tau2 = max(0, var(r_a) - mean(v_a))    between-arm variance (method of moments)
--                     multiplier = exp(B_a * r_a),  B_a = tau2 / (tau2 + v_a)
--                   The value multiplier does the same with the log of the arm's mean first charge
--                   over the fit's pooled mean (v = CV^2 / converters). When the arms differ no more
--                   than noise explains, tau2 = 0 and every multiplier is exactly 1.
{%- set flag_media = {'suite-default-model-create-image': 'image', 'suite-default-model-create-video': 'video'} %}

with scored as (

    select
        s.fit_id,
        o.user_id,
        o.converted_after_24h,
        o.first_subscription_cash_usd,
        o.arm_create_image,
        o.arm_create_video,
        r.p_convert
    from {{ ref('int_pp__fit_sets') }} as s
    inner join {{ ref('int_pp__user_outcomes') }} as o on o.user_id = s.user_id
    inner join {{ ref('int_pp__segment_rates') }} as r on r.fit_id = s.fit_id and r.segment = o.segment
    where o.is_conversion_mature
      and o.segment <> 'paid_24h'

),

pooled_value as (

    select
        fit_id,
        avg(first_subscription_cash_usd) as mean_first_charge_usd,
        {{ stddev_samp('first_subscription_cash_usd') }} as sd_first_charge_usd
    from scored
    where converted_after_24h
    group by fit_id

),

per_arm as (

    {% for flag, media in flag_media.items() -%}
    select
        fit_id,
        '{{ flag }}' as flag_key,
        arm_create_{{ media }} as arm,
        count(*) as matured_users,
        sum(case when converted_after_24h then 1 else 0 end) as observed_conversions,
        sum(p_convert) as expected_conversions,
        avg(case when converted_after_24h then first_subscription_cash_usd end) as mean_first_charge_usd
    from scored
    where arm_create_{{ media }} is not null
    group by fit_id, arm_create_{{ media }}
    {% if not loop.last %}union all{% endif %}
    {% endfor %}

),

stats as (

    select
        a.*,
        pv.mean_first_charge_usd as pooled_mean_first_charge_usd,
        ln((a.observed_conversions + 0.5) / (a.expected_conversions + 0.5)) as log_ratio,
        1.0 / (a.observed_conversions + 0.5) as sampling_var,
        case when a.observed_conversions > 0 and a.mean_first_charge_usd > 0 and pv.mean_first_charge_usd > 0
             then ln(a.mean_first_charge_usd / pv.mean_first_charge_usd) end as value_log_ratio,
        case when a.observed_conversions > 0 and pv.mean_first_charge_usd > 0
             then power(coalesce(pv.sd_first_charge_usd, 0) / pv.mean_first_charge_usd, 2) / a.observed_conversions end as value_sampling_var
    from per_arm as a
    left join pooled_value as pv on pv.fit_id = a.fit_id

),

between_arms as (

    select
        fit_id,
        flag_key,
        {{ greatest_of('var_samp(log_ratio) - avg(sampling_var)', 0) }} as tau2,
        {{ greatest_of('var_samp(value_log_ratio) - avg(value_sampling_var)', 0) }} as tau2_value
    from stats
    group by fit_id, flag_key

)

select
    s.fit_id,
    s.flag_key,
    s.arm,
    s.matured_users,
    s.observed_conversions,
    round(s.expected_conversions, 9) as expected_conversions,
    round(s.pooled_mean_first_charge_usd, 9) as pooled_mean_first_charge_usd,
    round(s.log_ratio, 9) as log_ratio,
    round(s.sampling_var, 9) as sampling_var,
    round(b.tau2, 9) as tau2,
    round(b.tau2 / (b.tau2 + s.sampling_var), 9) as shrinkage_weight,
    round(exp(b.tau2 / (b.tau2 + s.sampling_var) * s.log_ratio), 9) as conversion_multiplier,
    round(b.tau2_value, 9) as tau2_value,
    round(coalesce(
        exp(b.tau2_value / nullif(b.tau2_value + s.value_sampling_var, 0) * s.value_log_ratio),
        1.0
    ), 9) as value_multiplier
from stats as s
inner join between_arms as b on b.fit_id = s.fit_id and b.flag_key = s.flag_key
