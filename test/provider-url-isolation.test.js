'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry, pollAll } = require('../src/main/providers');

const networkProviders = ['zai', 'grok', 'gemini', 'openrouter'];
const paths = {
  zai: '/api/monitor/usage/quota/limit',
  grok: '/v1/api-key',
  gemini: '/v1beta/models?pageSize=1',
  openrouter: '/api/v1/key',
};
const defaultBases = {
  zai: 'https://api.z.ai',
  grok: 'https://api.x.ai',
  gemini: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai',
};

async function capturePoll(overrides = {}) {
  const requests = [];
  const deps = Object.fromEntries(networkProviders.map((id) => [`${id}Deps`, {
    getKey: async () => `fake-${id}-key`,
    ...overrides[id],
  }]));
  const registry = createRegistry(deps).filter((provider) => networkProviders.includes(provider.id));
  const result = await pollAll(registry, {
    baseUrl: 'https://wrong-shared-host.invalid',
    retries: 0,
    fetchImpl: async (url, options) => {
      requests.push({ url, headers: options.headers });
      return { ok: true, status: 200, json: async () => ({ data: { limits: [], usage: 1, limit: 10 }, models: [] }) };
    },
  });
  for (const id of networkProviders) assert.equal(result[id].ok, true);
  return requests;
}

function assertRequests(requests, bases) {
  assert.equal(requests.length, networkProviders.length);
  for (const id of networkProviders) {
    const request = requests.find((entry) => entry.url === `${bases[id]}${paths[id]}`);
    assert.ok(request, `${id} uses its own endpoint`);
    if (id === 'gemini') {
      assert.equal(request.headers['x-goog-api-key'], 'fake-gemini-key');
      assert.equal(request.headers.Authorization, undefined);
    } else {
      assert.equal(request.headers.Authorization, `Bearer fake-${id}-key`);
      assert.equal(request.headers['x-goog-api-key'], undefined);
    }
  }
}

test('shared base URL cannot redirect provider authentication to another host', async () => {
  assertRequests(await capturePoll(), defaultBases);
});

test('explicit provider base URL overrides remain isolated and supported', async () => {
  const bases = Object.fromEntries(networkProviders.map((id) => [id, `https://${id}-test.invalid`]));
  const overrides = Object.fromEntries(networkProviders.map((id) => [id, { baseUrl: bases[id] }]));
  assertRequests(await capturePoll(overrides), bases);
});
