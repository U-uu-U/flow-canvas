-- Run with psql -v ON_ERROR_STOP=1 after a server-side backup.
-- Inherit the working variable-duration HM route; do not change its price/key.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE models, billing_rules, channels IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
    template models%ROWTYPE;
    billing billing_rules%ROWTYPE;
    item RECORD;
    currency JSONB;
    exchange NUMERIC;
    next_mid BIGINT;
    new_billing BIGINT;
    sale_usd NUMERIC;
    channel_id BIGINT;
BEGIN
    SELECT * INTO STRICT template FROM models WHERE model_id = 'seedance_v2.5' AND is_active = 1;
    SELECT * INTO STRICT billing FROM billing_rules WHERE id = template.billing_rule_id;
    SELECT id INTO STRICT channel_id FROM channels
    WHERE base_url IN ('https://video.zhubo.asia', 'https://video.zhubo.asia/v1')
      AND models::jsonb ? template.mid AND status = 1;
    SELECT value::jsonb INTO STRICT currency FROM settings WHERE key = 'currency_settings';
    SELECT (entry->>'exchange_rate')::numeric INTO STRICT exchange
      FROM jsonb_array_elements(currency->'auxiliary_currencies') entry
      WHERE entry->>'code' = 'CNY' AND (entry->>'enabled')::boolean;
    IF currency->>'default_currency' <> 'USD' OR exchange <= 0
       OR billing.billing_type <> 'requests' OR billing.billing_rule <> 'fixed'
       OR abs(billing.fixed_rate * exchange - 5) > 0.001 THEN
        RAISE EXCEPTION 'Existing HM billing contract changed; inspect before continuing';
    END IF;
    IF EXISTS (SELECT 1 FROM models WHERE model_id IN ('seedance_v2.0-933', 'seedance_v2.5-101010', 'seedance_v2.5-301010')) THEN
        RAISE EXCEPTION 'HM models already exist; refusing duplicate model/billing records';
    END IF;
    SELECT max(mid::bigint) INTO next_mid FROM models WHERE mid ~ '^[0-9]+$';
    FOR item IN SELECT * FROM (VALUES
        ('seedance_v2.0-933', 'HM-Seedance V2.0 933', 6.5, '人脸参考受限；720p；4-15秒；最多9图、3视频、3音频参考；固定按次计费'),
        ('seedance_v2.5-101010', 'HM-Seedance V2.5 101010', 7, '人脸参考受限；720p；4-30秒；最多10图、10视频、10音频参考；固定按次计费'),
        ('seedance_v2.5-301010', 'HM-Seedance V2.5 301010', 10, '人脸参考受限；720p；4-30秒；最多30图、10视频、10音频参考；固定按次计费')
    ) AS entries(model_id, name, cny, description) LOOP
        sale_usd := item.cny / exchange;
        new_billing := nextval('billing_rules_id_seq');
        next_mid := coalesce(next_mid, 308000) + 1;
        INSERT INTO billing_rules SELECT updated.* FROM jsonb_populate_record(NULL::billing_rules, to_jsonb(billing) || jsonb_build_object(
            'id', new_billing, 'pid', '', 'name', item.name || ' CNY ' || item.cny || '/次',
            'fixed_rate', sale_usd, 'created_at', now(), 'updated_at', now(),
            'extended_config', jsonb_build_object('supported_models', jsonb_build_array(item.model_id),
                'enable_time_multipliers', false, 'time_multipliers', '[]'::jsonb)::text
        )) AS updated;
        INSERT INTO models SELECT updated.* FROM jsonb_populate_record(NULL::models, to_jsonb(template) || jsonb_build_object(
            'id', nextval('models_id_seq'), 'mid', next_mid::text,
            'model_id', item.model_id, 'original_id', item.model_id, 'model_id_alias', '', 'name', item.name,
            'billing_rule_id', new_billing, 'pre_deduction', sale_usd,
            'description', item.description || '；售价人民币' || item.cny || '元/次',
            'remark', 'HM 2026-09-12; sale CNY ' || item.cny || '/request; exchange=' || exchange,
            'feature_attributes', '["文生视频","图生视频","多模态参考生视频"]',
            'created_at', now(), 'updated_at', now()
        )) AS updated;
        UPDATE channels SET
            models = (models::jsonb || jsonb_build_array(next_mid::text))::text,
            model_mapping = (model_mapping::jsonb || jsonb_build_object(item.model_id, item.model_id))::text,
            updated_at = now()
        WHERE id = channel_id;
    END LOOP;
END $$;
COMMIT;
SELECT m.model_id, m.mid, m.billing_rule_id, b.fixed_rate, m.description
FROM models m JOIN billing_rules b ON b.id = m.billing_rule_id
WHERE m.model_id IN ('seedance_v2.5', 'seedance_v2.0-933', 'seedance_v2.5-101010', 'seedance_v2.5-301010');
