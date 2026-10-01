{#- Stripe helpers shared by the staging layer and the data-quality quarantine. -#}

{#-
  Event types the staging layer reads. Anything else is listed in fct_data_quality_quarantine
  (and warned about by assert_stripe_event_types_handled) instead of failing the whole build.
-#}
{% macro stripe_handled_event_types() -%}
  {{ return([
    'checkout.session.completed',
    'invoice.paid',
    'invoice_payment.paid',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'charge.refunded',
    'charge.dispute.created',
    'charge.dispute.updated',
    'charge.dispute.closed',
    'charge.dispute.funds_withdrawn',
    'charge.dispute.funds_reinstated'
  ]) }}
{%- endmacro %}

{#-
  Whitelist of the Stripe object fields the warehouse reads (stg_stripe__*). Everything else a
  live object carries (customer_email, customer_name, customer_address, customer_phone,
  customer_details, billing_details, shipping, receipt_email/receipt_url, hosted_invoice_url,
  invoice_pdf, payment_method_details, dispute evidence, metadata other than the three keys
  below) never leaves the raw dataset. Invoice `lines` and subscription `items` are kept as
  arrays: their elements carry prices, periods and quantities, not customer data.
-#}
{% macro stripe_object_whitelist(obj) -%}
  json_object(
    'id', {{ json_str(obj, '$.id') }},
    'object', {{ json_str(obj, '$.object') }},
    'customer', {{ json_str(obj, '$.customer') }},
    'status', {{ json_str(obj, '$.status') }},
    'mode', {{ json_str(obj, '$.mode') }},
    'payment_status', {{ json_str(obj, '$.payment_status') }},
    'billing_reason', {{ json_str(obj, '$.billing_reason') }},
    'currency', {{ json_str(obj, '$.currency') }},
    'amount', {{ json_int(obj, '$.amount') }},
    'amount_paid', {{ json_int(obj, '$.amount_paid') }},
    'amount_total', {{ json_int(obj, '$.amount_total') }},
    'amount_subtotal', {{ json_int(obj, '$.amount_subtotal') }},
    'amount_refunded', {{ json_int(obj, '$.amount_refunded') }},
    'total', {{ json_int(obj, '$.total') }},
    'subtotal', {{ json_int(obj, '$.subtotal') }},
    'total_excluding_tax', {{ json_int(obj, '$.total_excluding_tax') }},
    'total_details', json_object('amount_tax', {{ json_int(obj, '$.total_details.amount_tax') }}),
    'created', {{ json_int(obj, '$.created') }},
    'period_start', {{ json_int(obj, '$.period_start') }},
    'period_end', {{ json_int(obj, '$.period_end') }},
    'status_transitions', json_object('paid_at', {{ json_int(obj, '$.status_transitions.paid_at') }}),
    'parent', json_object('subscription_details', json_object('subscription', {{ json_str(obj, '$.parent.subscription_details.subscription') }})),
    'subscription', {{ json_str(obj, '$.subscription') }},
    'invoice', {{ json_str(obj, '$.invoice') }},
    'charge', {{ json_str(obj, '$.charge') }},
    'payment_intent', {{ json_str(obj, '$.payment_intent') }},
    'payment', json_object(
      'type', {{ json_str(obj, '$.payment.type') }},
      'payment_intent', {{ json_str(obj, '$.payment.payment_intent') }},
      'charge', {{ json_str(obj, '$.payment.charge') }}
    ),
    'lines', {{ json_query(obj, '$.lines') }},
    'items', {{ json_query(obj, '$.items') }},
    'client_reference_id', {{ json_str(obj, '$.client_reference_id') }},
    'success_url', {{ json_str(obj, '$.success_url') }},
    'metadata', json_object(
      'ga_client_id', {{ json_str(obj, '$.metadata.ga_client_id') }},
      'ga_session_id', {{ json_str(obj, '$.metadata.ga_session_id') }},
      'tolt_referral', {{ json_str(obj, '$.metadata.tolt_referral') }}
    ),
    'reason', {{ json_str(obj, '$.reason') }},
    'cancel_at_period_end', {{ json_bool(obj, '$.cancel_at_period_end') }},
    'cancel_at', {{ json_int(obj, '$.cancel_at') }},
    'canceled_at', {{ json_int(obj, '$.canceled_at') }},
    'ended_at', {{ json_int(obj, '$.ended_at') }},
    'latest_invoice', {{ json_str(obj, '$.latest_invoice') }}
  )
{%- endmacro %}

{# previous_attributes: only the fields the refund-step cross-check and subscription history read. #}
{% macro stripe_previous_attributes_whitelist(obj) -%}
  json_object(
    'amount_refunded', {{ json_int(obj, '$.amount_refunded') }},
    'status', {{ json_str(obj, '$.status') }},
    'cancel_at_period_end', {{ json_bool(obj, '$.cancel_at_period_end') }}
  )
{%- endmacro %}
