-- Logged assignment probabilities (propensities) per flag, arm and allocation slice over time.
-- Production: point var allocation_log_relation at the table the bandit-allocator appends its
-- applied LaunchDarkly weights to (columns: flag_key, arm, allocation_slice, valid_from DATE,
-- valid_to DATE (exclusive, NULL = open), assignment_probability, data_origin). Without it the
-- readouts carry NULL propensities (propensity_source = 'unavailable'), never a guess.
-- Fixture runs use seeds/allocation_log_synthetic.csv (the generator's equal split, SYNTHETIC).
-- depends_on: {{ ref('allocation_log_synthetic') }}
{%- set relation = var('allocation_log_relation', none) %}
{% if relation %}
select flag_key, arm, allocation_slice, cast(valid_from as date) as valid_from, cast(valid_to as date) as valid_to,
       cast(assignment_probability as {{ type_double() }}) as assignment_probability, data_origin
from {{ relation }}
{% elif is_fixture_mode() %}
select flag_key, arm, allocation_slice, cast(valid_from as date) as valid_from, cast(valid_to as date) as valid_to,
       cast(assignment_probability as {{ type_double() }}) as assignment_probability, data_origin
from {{ ref('allocation_log_synthetic') }}
{% else %}
select
    cast(null as {{ dbt.type_string() }}) as flag_key,
    cast(null as {{ dbt.type_string() }}) as arm,
    cast(null as {{ dbt.type_string() }}) as allocation_slice,
    cast(null as date) as valid_from,
    cast(null as date) as valid_to,
    cast(null as {{ type_double() }}) as assignment_probability,
    cast(null as {{ dbt.type_string() }}) as data_origin
from {{ ref('allocation_log_synthetic') }}
where false
{% endif %}
