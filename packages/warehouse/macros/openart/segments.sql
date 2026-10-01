{#-
  The bandit-allocator's allocation segments (packages/bandit-allocator/src/segments.ts), in SQL,
  so the warehouse's daily readout rows land in exactly the cells the allocator keys on.
  test/bandit-readout.test.ts checks every fixture user against the TypeScript functions.
    country_bucket  us | tier1 | rest | unknown  (seeds/segment_country_buckets.csv mirrors
                    TIER1_ISO2 and COUNTRY_NAME_TO_ISO2; 2-letter inputs are ISO codes)
    device          desktop | mobile | tablet | unknown  (deviceFromAmplitude)
    channel         google_cpc | meta_paid_social | tiktok_paid_social | affiliate | other_paid | organic
                    (channelFromUserProperties over the attribution plugin's initial_* properties)
-#}

{# Join key into segment_country_buckets: ISO-2 codes upper-cased, names lower-cased (both trimmed). #}
{% macro segment_country_key(country_expr) -%}
  case
    when {{ regexp_like('trim(' ~ country_expr ~ ')', '^[A-Za-z]{2}$') }} then upper(trim({{ country_expr }}))
    else lower(trim({{ country_expr }}))
  end
{%- endmacro %}

{# Bucket from the raw country and the joined seed row's bucket (NULL when the key is not listed). #}
{% macro segment_country_bucket(country_expr, seed_bucket_expr) -%}
  case
    when trim(coalesce({{ country_expr }}, '')) = '' then 'unknown'
    else coalesce({{ seed_bucket_expr }}, 'rest')
  end
{%- endmacro %}

{% macro segment_device(platform_expr, os_expr, device_type_expr) -%}
  case
    when coalesce({{ platform_expr }}, '') = '' and coalesce({{ os_expr }}, '') = '' and coalesce({{ device_type_expr }}, '') = '' then 'unknown'
    when {{ regexp_like('lower(coalesce(' ~ device_type_expr ~ ", ''))", 'ipad|tablet|kindle|galaxy tab') }} then 'tablet'
    when lower(coalesce({{ platform_expr }}, '')) in ('ios', 'android') then 'mobile'
    when {{ regexp_like('lower(coalesce(' ~ os_expr ~ ", ''))", 'mobile|iphone|android|ios') }}
      or {{ regexp_like('lower(coalesce(' ~ device_type_expr ~ ", ''))", 'iphone|android|pixel|galaxy|mobile') }} then 'mobile'
    else 'desktop'
  end
{%- endmacro %}

{# Channel from first-touch properties; `p` is a column prefix such as 'e.up_' (columns <p>initial_gclid, ...). #}
{% macro segment_channel(p) -%}
  case
    when coalesce({{ p }}initial_gclid, '') <> '' or coalesce({{ p }}initial_gbraid, '') <> '' or coalesce({{ p }}initial_wbraid, '') <> '' then 'google_cpc'
    when coalesce({{ p }}initial_fbclid, '') <> '' then 'meta_paid_social'
    when coalesce({{ p }}initial_ttclid, '') <> '' then 'tiktok_paid_social'
    when lower(coalesce({{ p }}initial_utm_medium, '')) = 'affiliate'
      or lower(coalesce({{ p }}initial_utm_source, '')) = 'tolt'
      or coalesce({{ p }}initial_ref, '') <> ''
      or coalesce({{ p }}tolt_referral, '') <> '' then 'affiliate'
    when {{ regexp_like('lower(coalesce(' ~ p ~ "initial_utm_medium, ''))", 'cpc|ppc|paid|display|cpm') }} then 'other_paid'
    else 'organic'
  end
{%- endmacro %}

{# The fixed LaunchDarkly holdout rule, recomputed from the context key (bandit launchdarkly.ts HOLDOUT_KEY_PATTERN). #}
{% macro allocation_slice(user_id_expr) -%}
  case when {{ regexp_like(user_id_expr, var('holdout_key_pattern')) }} then 'holdout' else 'bandit' end
{%- endmacro %}
