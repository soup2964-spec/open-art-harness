{{ config(materialized='view') }}
-- BI view: the parameter set the current scores use (no user data).
select d.*
from {{ ref('dim_model_parameters') }} as d
where d.fitted_params_ref = (select max(fitted_params_ref) from {{ ref('int_model_parameters__current') }})
