// 单元测试用的固定配置（仅测试使用的假密钥）。必须在被测模块之前导入。
Object.assign(process.env, {
  APP_MODE: 'demo',
  TOKEN_SECRET: 'unit-test-token-secret-0123456789abcdef',
  ID_HASH_KEY: 'unit-test-id-hash-key-0123456789abcdef',
  PAY_NOTIFY_SECRET: 'unit-test-pay-notify-secret-0123456789',
  OPS_TOKEN: 'unit-test-ops-token-0123456789abcdefgh',
  LOG_LEVEL: 'silent'
});
