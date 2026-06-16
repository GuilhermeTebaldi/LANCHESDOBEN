import assert from 'node:assert/strict';
import test from 'node:test';

const TEST_DATABASE_URL = 'postgresql://user:pass@localhost:5432/xburger_test';
const TEST_JWT_SECRET = '0123456789abcdef0123456789abcdef';

let importCounter = 0;

const importFreshEnvModule = async () => {
  importCounter += 1;
  return import(`./env.js?env-test-case=${importCounter}`);
};

const withPatchedEnv = async (
  patch: Record<string, string | undefined>,
  run: () => Promise<void>
): Promise<void> => {
  const previousValues = new Map<string, string | undefined>();
  Object.entries(patch).forEach(([key, value]) => {
    previousValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  });

  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await run();
  } finally {
    console.error = originalConsoleError;
    previousValues.forEach((value, key) => {
      if (value === undefined) {
        delete process.env[key];
        return;
      }
      process.env[key] = value;
    });
  }
};

test('base env loads backup settings without JWT secret', async () => {
  await withPatchedEnv(
    {
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: undefined,
      JWT_EXPIRES_IN: undefined,
      CORS_ORIGINS: 'https://app.example.com, https://admin.example.com',
    },
    async () => {
      const module = await importFreshEnvModule();

      assert.equal(module.env.DATABASE_URL, TEST_DATABASE_URL);
      assert.deepEqual(module.env.corsOrigins, ['https://app.example.com', 'https://admin.example.com']);
      assert.equal(module.env.FAST_CHECKOUT_V2_ENABLED, false);
      assert.equal(module.env.FAST_CHECKOUT_V2_CREATE_SALE_ENABLED, false);
      assert.throws(() => module.getAuthEnv(), /auth/i);
    }
  );
});

test('base env parses fast checkout v2 flag explicitly', async () => {
  await withPatchedEnv(
    {
      DATABASE_URL: TEST_DATABASE_URL,
      FAST_CHECKOUT_V2_ENABLED: 'true',
    },
    async () => {
      const module = await importFreshEnvModule();

      assert.equal(module.env.FAST_CHECKOUT_V2_ENABLED, true);
    }
  );
});

test('base env parses fast checkout v2 create-sale flag explicitly', async () => {
  await withPatchedEnv(
    {
      DATABASE_URL: TEST_DATABASE_URL,
      FAST_CHECKOUT_V2_CREATE_SALE_ENABLED: 'true',
    },
    async () => {
      const module = await importFreshEnvModule();

      assert.equal(module.env.FAST_CHECKOUT_V2_CREATE_SALE_ENABLED, true);
    }
  );
});

test('getAuthEnv validates JWT settings and applies defaults', async () => {
  await withPatchedEnv(
    {
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: TEST_JWT_SECRET,
      JWT_EXPIRES_IN: undefined,
    },
    async () => {
      const module = await importFreshEnvModule();
      const authEnv = module.getAuthEnv();

      assert.equal(authEnv.JWT_SECRET, TEST_JWT_SECRET);
      assert.equal(authEnv.JWT_EXPIRES_IN, '12h');
    }
  );
});

test('base env still requires DATABASE_URL', async () => {
  await withPatchedEnv(
    {
      DATABASE_URL: undefined,
      JWT_SECRET: TEST_JWT_SECRET,
    },
    async () => {
      await assert.rejects(importFreshEnvModule, /base/i);
    }
  );
});
