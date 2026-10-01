-- ExperimentExposure contract (packages/contracts/src/schemas/experiment-exposure.schema.json):
-- one row per (user, flag) with the arm and the first exposure. Contract columns first;
-- n_distinct_arms and is_qa_account are warehouse-only (exposed-to-two-arms users are
-- excluded from readouts).
select
    x.user_id,
    x.flag_key,
    x.arm,
    x.first_exposed_at,
    x.source,
    x.device_id,
    x.n_distinct_arms,
    {{ qa_account_flag('x.user_id') }} as is_qa_account
from {{ ref('int_experiment__exposures') }} as x
