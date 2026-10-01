{{
  config(
    materialized='incremental',
    incremental_strategy=append_only_strategy(),
    full_refresh=false,
    on_schema_change='append_new_columns'
  )
}}
-- Every parameter set any score was ever produced with, APPEND-ONLY: one row per
-- (fitted_params_ref, parameter_name). A run inserts its set (int_model_parameters__current:
-- vars labelled OBSERVED / ILLUSTRATIVE / CONFIG and FITTED values) only when that ref is new, so
-- `where fitted_params_ref = <a score's ref>` always returns the exact values behind the score,
-- even after the model or the data moved on (ML review 3). full_refresh is disabled: this is a log.
select
    c.fitted_params_ref,
    c.parameter_name,
    c.parameter_value,
    c.label,
    c.used_in,
    c.source,
    c.fit_id,
    c.pp_model_version,
    c.pvs_model_version,
    c.snapshot_as_of as first_snapshot_as_of,
    c.run_id as first_run_id
from {{ ref('int_model_parameters__current') }} as c
{% if openart_is_incremental() %}
where not exists (
    select 1 from {{ this }} as d where d.fitted_params_ref = c.fitted_params_ref
)
{% endif %}
