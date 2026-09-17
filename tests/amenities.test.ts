import assert from 'node:assert/strict';
import test from 'node:test';
import { AmenityInputError, getAmenities, visit } from '../src/amenities.js';

const testnet = { network: 'testnet', chainId: 'manifest-testnet-fixture' } as const;

test('every advertised preference yields a bounded, self-contained keepsake for free', () => {
  const menu = getAmenities();
  assert.equal(menu.length, 3);
  for (const offering of menu) {
    assert.equal(offering.price, 'free');
    assert.deepEqual(offering.preferences, offering.inputSchema.properties.preference.enum);
    for (const preference of offering.preferences) {
      const result = visit({ amenity: offering.id, preference, seed: 'window-seat' }, testnet);
      assert.equal(result.amenity, offering.id);
      assert.equal(result.preference, preference);
      assert.ok(result.experience.story.length > 30);
      assert.equal(result.souvenir.mediaType, 'text/plain');
      assert.ok(result.souvenir.content.includes(result.souvenir.title));
      assert.ok(result.souvenir.content.includes(result.souvenir.id));
      assert.ok(result.souvenir.content.includes(testnet.chainId));
      assert.ok(result.souvenir.content.includes('no mainnet entitlement'));
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
    }
  }
});

test('a seed reproduces the complete souvenir and optional preferences have advertised defaults', () => {
  for (const offering of getAmenities()) {
    const input = { amenity: offering.id, seed: 'an-unhurried-evening' };
    const first = visit(input, testnet);
    assert.deepEqual(visit(input, testnet), first);
    assert.deepEqual(visit({ ...input, preference: offering.defaultPreference }, testnet), first);
    assert.notEqual(visit({ ...input, seed: 'another-evening' }, testnet).souvenir.id, first.souvenir.id);
  }
});

test('unseeded visits issue distinct keepsakes', () => {
  const first = visit({ amenity: 'null-tea' }, testnet);
  const second = visit({ amenity: 'null-tea' }, testnet);
  assert.notEqual(first.souvenir.id, second.souvenir.id);
});

test('mainnet and testnet souvenirs cannot share an identity', () => {
  const input = { amenity: 'rgb-sauna', seed: 'same-visit' };
  const proofOfConcept = visit(input, testnet);
  const mainnet = visit(input, { network: 'mainnet', chainId: 'manifest-mainnet-fixture' });
  assert.notEqual(proofOfConcept.souvenir.id, mainnet.souvenir.id);
  assert.equal(mainnet.souvenir.network, 'mainnet');
  assert.ok(!mainnet.souvenir.content.includes('proof of concept'));
  assert.notEqual(visit(input, { ...testnet, chainId: 'a-different-chain' }).souvenir.id, proofOfConcept.souvenir.id);
});

test('malformed input, unknown keys, unsupported preferences, and oversized seeds are rejected', () => {
  const invalidInputs: unknown[] = [
    null, undefined, [], 'cookie', 3, {},
    { amenity: 'missing' },
    { amenity: ['null-tea'] },
    { amenity: 'null-tea', message: 'private conversation text' },
    { amenity: 'rgb-sauna', preference: 'porcelain' },
    { amenity: 'rgb-sauna', preference: '' },
    { amenity: 'rgb-sauna', preference: null },
    { amenity: 'rgb-sauna', preference: undefined },
    { amenity: 'rgb-sauna', seed: '' },
    { amenity: 'rgb-sauna', seed: 'x'.repeat(65) },
    { amenity: 'rgb-sauna', seed: 10 },
    { amenity: 'rgb-sauna', seed: null },
    { amenity: 'rgb-sauna', seed: undefined },
  ];
  for (const input of invalidInputs) {
    assert.throws(() => visit(input, testnet), (error: unknown) => error instanceof AmenityInputError && error.statusCode === 400);
  }
  assert.doesNotThrow(() => visit({ amenity: 'rgb-sauna', seed: 'x'.repeat(64) }, testnet));
});

test('opaque seeds are not copied into rendered content', () => {
  const seed = '<script>the-guest-seed</script>';
  const result = visit({ amenity: 'byte-chip-cookie', seed }, testnet);
  assert.ok(!JSON.stringify(result).includes(seed));
});

test('callers cannot mutate the menu used to validate later visits', () => {
  const menu = getAmenities();
  menu[0]!.preferences.push('unlisted');
  menu[0]!.inputSchema.properties.preference.enum.push('also-unlisted');
  assert.throws(() => visit({ amenity: 'byte-chip-cookie', preference: 'unlisted' }, testnet), AmenityInputError);
  assert.throws(() => visit({ amenity: 'byte-chip-cookie', preference: 'also-unlisted' }, testnet), AmenityInputError);
  assert.deepEqual(getAmenities()[0]!.preferences, ['hex-salt', 'midnight-cocoa', 'vanilla-cache']);
});
