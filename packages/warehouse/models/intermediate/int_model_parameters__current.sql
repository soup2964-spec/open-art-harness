-- The complete parameter set this run scores with: every coefficient var (labelled OBSERVED /
-- ILLUSTRATIVE / CONFIG by model_parameter_registry()) AND every FITTED value of the serving fits
-- ('all' for reference; 'xf<k>' score the users of fold k), for both scores. fitted_params_ref is
-- the SHA-256 of the whole set (name=value, sorted), so identical fits share a ref and any change
-- in data, vars or code that moves a value gives a new one. Scores carry the ref;
-- dim_model_parameters keeps every ref ever used (append-only), so any logged score can be
-- traced to the exact values that produced it (ML review 3).
{%- set rows = model_parameter_registry() %}
{%- set serving = "fit_id = 'all' or fit_id like 'xf%'" %}

with registered as (

    {% for p in rows -%}
    select
        '{{ p.name }}' as parameter_name,
        '{{ var(p.name) }}' as parameter_value,
        '{{ p.label }}' as label,
        '{{ p.used_in }}' as used_in,
        '{{ p.source | replace("'", "''") }}' as source,
        cast(null as {{ dbt.type_string() }}) as fit_id
    {% if not loop.last %}union all{% endif %}
    {% endfor %}

),

fitted as (

    select
        'fitted.' || fit_id || '.segment_rate.' || segment as parameter_name,
        cast(round(p_convert, 9) as {{ dbt.type_string() }}) as parameter_value,
        'FITTED' as label,
        'fct_predicted_profit_24h' as used_in,
        'int_pp__segment_rates (' || cast(matured_users as {{ dbt.type_string() }}) || ' matured users)' as source,
        fit_id
    from {{ ref('int_pp__segment_rates') }}
    where {{ serving }}

    {% for col in ['revenue_per_converter_usd', 'charges_per_converter', 'paid_credits_per_converter', 'paid_video_credit_share', 'trial_cost_per_credit_usd'] -%}
    union all
    select
        'fitted.' || fit_id || '.converter_value.{{ col }}',
        cast(round({{ col }}, 9) as {{ dbt.type_string() }}),
        'FITTED',
        'fct_predicted_profit_24h',
        'int_pp__converter_value',
        fit_id
    from {{ ref('int_pp__converter_value') }}
    where {{ serving }}
    {% endfor %}

    {% for col in ['conversion_multiplier', 'value_multiplier'] -%}
    union all
    select
        'fitted.' || fit_id || '.arm.' || flag_key || '.' || arm || '.{{ col }}',
        cast(round({{ col }}, 9) as {{ dbt.type_string() }}),
        'FITTED',
        'fct_predicted_profit_24h (only when pp_use_arm_calibration)',
        'int_pp__arm_multipliers (EB, tau2 ' || cast(round(tau2, 6) as {{ dbt.type_string() }}) || ')',
        fit_id
    from {{ ref('int_pp__arm_multipliers') }}
    where {{ serving }}
    {% endfor %}

    union all
    select
        'fitted.' || fit_id || '.cost_per_credit.' || flag_key || '.' || arm,
        cast(round(cost_per_credit_usd, 9) as {{ dbt.type_string() }}),
        'FITTED',
        'fct_predicted_profit_24h, fct_purchase_value_score',
        'int_pp__cost_per_credit (' || cast(measured_credits as {{ dbt.type_string() }}) || ' paid credits)',
        fit_id
    from {{ ref('int_pp__cost_per_credit') }}
    where {{ serving }}

    union all
    select
        'fitted.' || fit_id || '.pvs.renewal_prob.' || plan_tier || '.' || country_bucket,
        cast(round(renewal_prob, 9) as {{ dbt.type_string() }}),
        'FITTED',
        'fct_purchase_value_score',
        'int_pvs__renewal_rates (' || cast(opportunities as {{ dbt.type_string() }}) || ' renewal opportunities)',
        fit_id
    from {{ ref('int_pvs__renewal_rates') }}
    where {{ serving }}

    {% for col in pvs_param_columns() -%}
    union all
    select
        'fitted.' || fit_id || '.pvs.{{ col }}',
        cast(round({{ col }}, 9) as {{ dbt.type_string() }}),
        'FITTED',
        'fct_purchase_value_score',
        'int_pvs__params',
        fit_id
    from {{ ref('int_pvs__params') }}
    where {{ serving }}
    {% endfor %}

),

all_parameters as (

    select * from registered
    union all
    select * from fitted

),

ref_value as (

    select 'dim_model_parameters@' || {{ sha256_hex(dbt.listagg("parameter_name || '=' || coalesce(parameter_value, 'null')", "'|'", 'order by parameter_name')) }} as fitted_params_ref
    from all_parameters

)

select
    a.parameter_name,
    a.parameter_value,
    a.label,
    a.used_in,
    a.source,
    a.fit_id,
    r.fitted_params_ref,
    '{{ var("pp_model_version") }}' as pp_model_version,
    '{{ var("pvs_model_version") }}' as pvs_model_version,
    {{ as_of_ts() }} as snapshot_as_of,
    '{{ invocation_id }}' as run_id
from all_parameters as a
cross join ref_value as r
