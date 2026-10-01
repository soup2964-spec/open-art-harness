-- The adapter-dispatched sha256_hex macro against FIPS 180-4 test vectors and the Meta
-- external_id rule (SHA-256 of the lower-cased uid).
with cases as (

    select 'abc' as input_value, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' as expected
    union all
    select '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    union all
    select lower('SynthU02WonderYearB2'), 'bd12537f6dad55dc1ac50988e6241f8355923edcbcdf55f38edd25a84621e6ac'

)

select input_value, expected, {{ sha256_hex('input_value') }} as actual
from cases
where {{ sha256_hex('input_value') }} <> expected
