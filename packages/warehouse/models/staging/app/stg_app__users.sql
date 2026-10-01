-- App users (my-info subset). Email deliberately NOT carried into the warehouse models:
-- hashing for audiences happens in the export layer (audience-sync), per platform.
with ranked as (

    select
        *,
        row_number() over (partition by id order by account_created_at) as copy_number
    from {{ source('app', 'users') }}
    where account_created_at is null or account_created_at <= {{ as_of_ts() }}

)

select
    id as user_id,
    account_created_at,
    provider as auth_provider
from ranked
where copy_number = 1
