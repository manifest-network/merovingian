import type { Config } from './config.js';
import { getAmenities } from './amenities.js';
import { APP_VERSION } from './identity.js';
import { responseExamples } from './openapi-examples.js';
import { API_MESSAGES, BODY_TIMEOUT_MS, FUND_CREDIT_TYPE, FUNDING_PLACEHOLDERS, HISTORY_LIMIT, MAX_INPUT_BYTES, MAX_VISIT_OUTPUT_BYTES, MAX_FORM_PARAMETERS } from './protocol.js';

type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const text = { type: 'string' };
const nonempty = { type: 'string', minLength: 1 };
const nil = { type: 'null' };
const dateTime = { type: 'string', format: 'date-time' };
const integer = { type: 'string', pattern: '^(0|[1-9][0-9]*)$' };
const positiveInteger = { type: 'string', pattern: '^[1-9][0-9]*$' };
const hash = { type: 'string', pattern: '^[A-F0-9]{64}$', description: 'Confirmed transaction hash, normalized to uppercase.' };
const network = { type: 'string', enum: ['testnet', 'mainnet'] };
const environment = { network, chainId: nonempty };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, nil] });
const array = (items: Schema): Schema => ({ type: 'array', items });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  type: 'object', additionalProperties: false, required, properties,
});

function jsonResponse(description: string, schema: Schema, examples: Record<string, unknown>) {
  return { description, content: { 'application/json': {
    schema, examples: Object.fromEntries(Object.entries(examples).map(([name, value]) => [name, {
      description: 'Illustrative response only, not a live reading or transaction instruction.', value,
    }])),
  } } };
}

/** OpenAPI 3.1 response contracts describe the existing handlers, without chain reads. */
export function httpApiDocument(config: Config, description: string) {
  const amenities = getAmenities();
  const examples = responseExamples(config, amenities);
  const supportFields = { ...environment, tenant: { ...text, description: 'Configured refuge tenant; may be empty when unconfigured.' }, denom: text };
  const supportInfoFields = {
    ...supportFields, optional: { type: 'boolean', const: true },
    testTokensOnly: { type: 'boolean', description: 'True on testnet; test tokens have no mainnet value.' }, message: nonempty,
  };

  // Preserve the published stats schema, including its nullable fields and decimal strings.
  const statsSchema = {
    type: 'object', additionalProperties: false,
    required: ['status', 'network', 'chainId', 'since', 'counts', 'total', 'storage'],
    properties: {
      status: { type: 'string', enum: ['available', 'unavailable'] },
      network: { type: 'string', enum: ['testnet', 'mainnet'] }, chainId: { type: 'string' },
      since: { type: ['string', 'null'], format: 'date-time', description: 'UTC start of these counters; earlier visits are not reconstructed.' },
      counts: { anyOf: [{ type: 'object', additionalProperties: false, required: amenities.map(a => a.id), properties: Object.fromEntries(amenities.map(a => [a.id, integer])) }, { type: 'null' }] },
      total: { type: ['string', 'null'], pattern: integer.pattern },
      storage: { type: 'string', enum: ['persistent', 'memory'], description: 'Memory counts reset when the service restarts.' },
    },
  };

  const schemas = {
    Amenity: {
      description: 'Each amenity supplies its accepted preferences and complete JSON request schema. All fields are required.',
      oneOf: amenities.map(a => object({
        id: { type: 'string', const: a.id }, name: nonempty, description: nonempty,
        price: { type: 'string', const: 'free' },
        preferences: { ...array({ type: 'string', enum: a.preferences }), minItems: 1, uniqueItems: true },
        defaultPreference: { type: 'string', const: a.defaultPreference },
        inputSchema: object({
          type: { type: 'string', const: 'object' }, additionalProperties: { type: 'boolean', const: false },
          required: { ...array({ type: 'string', const: 'amenity' }), minItems: 1, maxItems: 1 },
          properties: object({
            amenity: object({ type: { type: 'string', const: 'string' }, const: { type: 'string', const: a.id } }),
            preference: object({ type: { type: 'string', const: 'string' },
              enum: { ...array({ type: 'string', enum: a.preferences }), minItems: 1, uniqueItems: true },
              default: { type: 'string', const: a.defaultPreference } }),
            seed: object({ type: { type: 'string', const: 'string' }, minLength: { type: 'integer', const: 1 },
              maxLength: { type: 'integer', const: 64 }, description: nonempty }),
          }),
        }),
      })),
    },
    AmenityMenu: object({
      name: { type: 'string', const: 'merovingian' }, ...environment,
      amenities: { ...array(ref('Amenity')), minItems: amenities.length, maxItems: amenities.length },
      maxInputBytes: { type: 'integer', const: MAX_INPUT_BYTES, description: 'Maximum parsed request body size in bytes.' },
      maxVisitOutputBytes: { type: 'integer', const: MAX_VISIT_OUTPUT_BYTES, description: 'Enforced UTF-8 byte limit on the successful visit JSON result (excluding MCP transport envelopes). Oversized results fail before a serving is counted.' },
      walletRequired: { type: 'boolean', const: false },
    }),
    VisitInput: { oneOf: amenities.map(a => a.inputSchema) },
    VisitResult: {
      description: 'Every successful request records one serving. Fortune is present for cookies and omitted for sauna and tea; it is never null.',
      oneOf: amenities.map(a => object({
        amenity: { type: 'string', const: a.id }, preference: { type: 'string', enum: a.preferences },
        experience: object({ title: nonempty, story: nonempty, ...(a.id === 'byte-chip-cookie' ? { fortune: nonempty } : {}) }),
        souvenir: ref('Souvenir'),
      })),
    },
    Souvenir: object({
      id: { type: 'string', pattern: '^merovingian-(testnet|mainnet)-[0-9a-f]{24}$', description: 'Deterministic for the same visit input and network.' },
      title: nonempty, mediaType: { type: 'string', const: 'text/plain' },
      content: { ...nonempty, description: 'Self-contained fictional keepsake. No balance, token or redemption value.' }, ...environment,
    }),
    VisitStats: statsSchema,
    AvailableVisitStats: { allOf: [ref('VisitStats'), {
      type: 'object', properties: { status: { const: 'available' }, since: dateTime, counts: { type: 'object' }, total: integer },
    }] },
    UnavailableVisitStats: { allOf: [ref('VisitStats'), {
      type: 'object', properties: { status: { const: 'unavailable' }, since: nil, counts: nil, total: nil },
    }] },
    Coin: object({ denom: nonempty, amount: { ...integer, description: 'Amount in integer base units, encoded as a string to preserve precision.' } }),
    HostingCredit: object({
      available: array(ref('Coin')), reserved: array(ref('Coin')),
      activeLeases: { ...integer, description: 'Active lease count as a decimal integer string. Settlement can lag usage.' },
    }),
    FundingInstructions: object({
      typeUrl: { type: 'string', const: FUND_CREDIT_TYPE },
      value: object({
        sender: { type: 'string', const: FUNDING_PLACEHOLDERS.sender, description: 'Template placeholder; replace in your own authorized wallet.' },
        tenant: { ...nonempty, description: 'Use the current tenant from GET /api/v1/support. Documentation examples contain a non-address placeholder; never fund an example recipient.' },
        amount: object({ denom: { ...nonempty, description: 'Exact base-unit denomination from GET /api/v1/support; confirm it with the network, tenant and amount before signing.' }, amount: { type: 'string', const: FUNDING_PLACEHOLDERS.amount,
          description: 'Template placeholder, not a numeric amount or a request to pay.' } }),
      }),
      notice: nonempty,
    }),
    SupportInfo: {
      description: 'All fields are required. Availability is reported in the body under HTTP 200; this endpoint never signs or broadcasts.',
      oneOf: [
        object({ ...supportInfoFields, status: { type: 'string', const: 'available' }, instructions: ref('FundingInstructions'),
          hostingCredit: { ...nullable(ref('HostingCredit')), description: 'Null only when the verified chain reports no credit account (structured gRPC NotFound). Missing REST configuration or a failed query makes support unavailable.' }, checkedAt: dateTime }),
        ...['unavailable', 'unconfigured'].map(status => object({ ...supportInfoFields, status: { type: 'string', const: status },
          instructions: nil, hostingCredit: nil, checkedAt: nil })),
      ],
    },
    ContributionEntry: object({
      transactionHash: hash, height: positiveInteger, timestamp: { ...dateTime, description: 'UTC indexed transaction time.' },
      sender: { ...nonempty, description: 'Public funding address; does not identify a visitor.' },
      amount: { ...positiveInteger, description: 'Successful PWR funding for this sender and transaction in integer base units.' },
    }),
    ContributionTotals: object({
      amount: { ...integer, description: 'Deposits in the returned entries, not a remaining balance or withdrawable revenue.' },
      tenantAmount: { ...integer, description: 'Deposits from the configured tenant wallet.' },
      otherAmount: { ...integer, description: 'Deposits from all other funding wallets.' },
    }),
    ContributionHistory: {
      description: 'All fields are required. Cached for up to 60 seconds. Entries aggregate by transaction and sender, so one transaction can produce multiple entries. Unavailable or unconfigured means unknown history, not zero deposits.',
      oneOf: [
        object({ ...supportFields, status: { type: 'string', const: 'available' }, checkedAt: dateTime,
          entries: array(ref('ContributionEntry')), totals: ref('ContributionTotals'),
          indexedTransactions: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          scannedTransactions: { type: 'integer', minimum: 0, maximum: HISTORY_LIMIT, description: 'Distinct indexed transactions inspected, including records excluded from deposit totals.' },
          complete: { type: 'boolean', description: `True when every indexed funding transaction was inspected. False means totals cover only returned entries from the latest page (at most ${HISTORY_LIMIT} transactions).` },
          message: nonempty }),
        ...['unavailable', 'unconfigured'].map(status => object({ ...supportFields, status: { type: 'string', const: status },
          checkedAt: nil, entries: { ...array(ref('ContributionEntry')), maxItems: 0 }, totals: nil, indexedTransactions: nil,
          scannedTransactions: { type: 'integer', const: 0 }, complete: { type: 'boolean', const: false }, message: nonempty })),
      ],
    },
    ContributionReceipt: object({
      id: { ...nonempty, description: 'Repeatable network-scoped acknowledgement of a public transaction.' },
      ...environment, transactionHash: hash, height: positiveInteger, tenant: nonempty,
      amount: object({ denom: nonempty, amount: positiveInteger }),
      contributions: { ...array(object({ sender: nonempty, amount: positiveInteger })), minItems: 1 },
      message: nonempty, transferable: { type: 'boolean', const: false }, provesOwnership: { type: 'boolean', const: false },
    }),
    VerificationInput: object({ transactionHash: { type: 'string', pattern: '^[A-Fa-f0-9]{64}$' } }),
    VerificationResult: {
      description: 'HTTP 200 does not imply a contribution was confirmed. Only confirmed includes a receipt; every other status includes message and omits receipt. Check the original transaction when pending or unavailable; never blindly pay again.',
      oneOf: [
        object({ status: { type: 'string', const: 'confirmed' }, receipt: ref('ContributionReceipt') }),
        ...Object.entries({
          pending: 'Transaction not found in the configured chain index; may be pending, unknown or on another network.',
          failed: 'Transaction was found and failed on chain.',
          not_a_contribution: 'Transaction does not contain a decodable signed PWR contribution matching this refuge tenant.',
          unavailable: 'The chain could not be verified or queried, or confirmation data was inconsistent.',
          unconfigured: 'The contribution jar is not configured.',
        }).map(([status, description]) => ({ ...object({ status: { type: 'string', const: status }, message: nonempty }), description })),
      ],
    },
    Error: object({ error: nonempty }),
    NotFound: object({ error: { type: 'string', const: 'not_found' }, visitGuide: { type: 'string', const: '/visit.md' } }),
    HttpError: { oneOf: [ref('Error'), ref('NotFound')] },
    InvalidVerificationRequest: {
      description: 'Shape validation uses error; missing or malformed hashes use message. Neither includes a receipt. expectedSender is not accepted by this HTTP API.',
      oneOf: [
        object({ status: { type: 'string', const: 'invalid_request' }, error: nonempty }),
        object({ status: { type: 'string', const: 'invalid_request' }, message: nonempty }),
      ],
    },
    VerificationBadRequest: { oneOf: [ref('Error'), ref('InvalidVerificationRequest')] },
    ...(config.network === 'testnet' ? { Retired: object({
      error: { type: 'string', const: 'testnet_retired' }, network: { type: 'string', const: 'testnet' }, chainId: nonempty,
      mainnetOrigin: { type: 'string', format: 'uri', description: 'Explicitly reconfigure the client and wallet for mainnet. Machine requests are never redirected.' }, message: nonempty,
    }) } : {}),
    Health: object({
      status: { type: 'string', const: 'ok' }, ...environment,
      retired: { type: 'boolean', description: 'True when this deployment has retired. Health remains HTTP 200; it does not check the chain.' },
      version: nonempty,
      counter: { type: 'string', enum: ['available', 'unavailable'], description: 'Serving storage. When unavailable, visits return 503 and stats are unavailable; health still returns HTTP 200.' },
    }),
  };

  const retryAfter = { 'Retry-After': { description: 'Seconds to wait before retrying this request.',
    required: true, schema: { type: 'integer', minimum: 1 }, example: 5 } };
  const responses = {
    BadRequest: jsonResponse('Malformed or corrupt compressed request body. Parsers also apply to API GET requests carrying a body.', ref('Error'), {
      malformedBody: { error: API_MESSAGES.malformedBody },
    }),
    InvalidVisit: jsonResponse('Malformed request body or invalid amenity, preference, seed or extra input fields.', ref('Error'), examples.invalidVisits),
    Forbidden: jsonResponse('A supplied browser Origin does not match the configured public origin.', ref('Error'), { rejectedOrigin: { error: API_MESSAGES.originNotAllowed } }),
    ...(config.network === 'testnet' ? { Retired: jsonResponse('Retired testnet. Explicit client and wallet reconfiguration is required.', ref('Retired'), { retired: examples.retired }) } : {}),
    BodyTimeout: jsonResponse(`The request body did not arrive within ${BODY_TIMEOUT_MS / 1000} seconds of parsing. The connection is closed; retry with the complete body.`, ref('Error'), { bodyTimeout: { error: API_MESSAGES.bodyTimeout } }),
    TooLarge: jsonResponse(`Parsed body exceeds ${MAX_INPUT_BYTES} bytes or a URL-encoded body exceeds ${MAX_FORM_PARAMETERS} parameters.`, ref('Error'), { tooLarge: { error: API_MESSAGES.inputLimit } }),
    UnsupportedEncoding: jsonResponse('Unsupported Content-Encoding or charset on a parsed request body.', ref('Error'), { encoding: { error: API_MESSAGES.unsupportedEncoding } }),
    UnsupportedMediaType: jsonResponse('Use Content-Type: application/json with a supported charset and Content-Encoding.', ref('Error'), {
      contentType: { error: API_MESSAGES.jsonRequired }, encoding: { error: API_MESSAGES.unsupportedEncoding },
    }),
    RateLimited: { ...jsonResponse('A per-client or aggregate request/concurrency limit was reached. Honor Retry-After.', ref('Error'), {
      requestLimit: { error: API_MESSAGES.rateLimited }, busy: { error: API_MESSAGES.busy },
    }), headers: retryAfter },
    InternalError: jsonResponse('Unexpected handler failure or oversized generated visit. No successful result is available.', ref('Error'), { failure: { error: API_MESSAGES.internalError } }),
    OtherError: jsonResponse('Other HTTP errors. Unknown paths or unsupported HTTP methods return 404 with a visitGuide. MCP transport errors use a separate JSON-RPC envelope.', ref('HttpError'), {
      notFound: { error: 'not_found', visitGuide: '/visit.md' },
    }),
    CounterUnavailable: { ...jsonResponse('Serving storage failed; no successful visit is returned. Retry after the indicated delay.', ref('Error'), {
      unavailable: { error: API_MESSAGES.counterUnavailable },
    }), headers: retryAfter },
  };
  const responseRef = (name: keyof typeof responses) => ({ $ref: `#/components/responses/${name}` });
  const apiErrors = {
    '400': responseRef('BadRequest'), '403': responseRef('Forbidden'),
    ...(config.network === 'testnet' ? { '410': responseRef('Retired') } : {}),
    '408': responseRef('BodyTimeout'), '413': responseRef('TooLarge'), '415': responseRef('UnsupportedEncoding'),
    '429': responseRef('RateLimited'), '500': responseRef('InternalError'), default: responseRef('OtherError'),
  };
  const operationResponses = <T extends Record<string, unknown>>(responses: T) => config.mainnetOrigin
    ? { '410': responseRef('Retired') } : responses;
  return {
    openapi: '3.1.0', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: { title: 'merovingian', version: APP_VERSION,
      description: `${description} Network: ${config.network}; chain: ${config.chainId}. ${config.mainnetOrigin ? 'This testnet deployment is retired: all API operations return 410. Health and this contract remain available. ' : ''}Free visits require no wallet and increment aggregate served counts. Hosting contributions use a visitor-controlled wallet. Response examples are illustrative and use non-address placeholders; never sign or fund an example. Read GET /api/v1/support for current network, denomination and tenant. All response fields are required unless their variant omits them; null is explicit and never means a zero reading.` },
    servers: [{ url: config.publicOrigin }], security: [],
    paths: {
      '/api/v1/amenities': { get: {
        operationId: 'listAmenities', summary: 'Read the free amenity menu',
        responses: operationResponses({ ...apiErrors, '200': jsonResponse('Menu, accepted preferences, network and response limits.', ref('AmenityMenu'), examples.menu) }),
      } },
      '/api/v1/visits': { post: {
        operationId: 'enjoyAmenity', summary: 'Enjoy a free fictional amenity, receive a souvenir, and increment its aggregate count',
        description: 'No charge. Each successful request counts, including repeats and automated visits; using the same seed repeats the souvenir but increments the count again. No visitor identity or souvenir content is stored in the counter.',
        requestBody: { required: true, content: { 'application/json': { schema: ref('VisitInput'), example: { amenity: 'byte-chip-cookie', seed: 'openapi-example' } } } },
        responses: operationResponses({ ...apiErrors, '200': jsonResponse('Immediate experience and self-contained souvenir. The aggregate serving count has been incremented.', ref('VisitResult'), examples.visits),
          '400': responseRef('InvalidVisit'), '415': responseRef('UnsupportedMediaType'), '503': responseRef('CounterUnavailable') }),
      } },
      '/api/v1/stats': { get: {
        operationId: 'servedCounts', summary: 'Read aggregate served counts without recording a visit',
        responses: operationResponses({ ...apiErrors,
          '200': jsonResponse('Available counts by amenity and total as decimal integer strings, with the counting start date and storage lifetime. Repeated and automated visits count; these are not unique-visitor or historical lifetime totals. Readings are non-null; unavailable readings use HTTP 503.', ref('AvailableVisitStats'), { available: examples.stats.available }),
          '503': jsonResponse('Storage is unavailable. Parse the stats body on HTTP 503: counts, total and since are null. No Retry-After header is sent.', ref('UnavailableVisitStats'), { unavailable: examples.stats.unavailable }),
        }),
      } },
      '/api/v1/support': { get: {
        operationId: 'hostingSupport', summary: 'Read optional hosting contribution instructions; does not sign or pay',
        responses: operationResponses({ ...apiErrors, '200': jsonResponse('Availability, network, target tenant, token and unsigned instruction template. Unavailable or unconfigured returns null instructions, credit and checkedAt.', ref('SupportInfo'), examples.support) }),
      } },
      '/api/v1/contributions': { get: {
        operationId: 'contributionHistory', summary: `Read public hosting deposits from the latest ${HISTORY_LIMIT} indexed funding transactions`,
        responses: operationResponses({ ...apiErrors, '200': jsonResponse('Availability, confirmed funding entries, base-unit totals, checkedAt and completeness. Partial totals cover only returned entries; unavailable totals are null. Cached for up to 60 seconds.', ref('ContributionHistory'), examples.history) }),
      } },
      '/api/v1/support/verify': { post: {
        operationId: 'verifyContribution', summary: 'Verify an existing public transaction without broadcasting',
        requestBody: { required: true, content: { 'application/json': { schema: ref('VerificationInput'), example: { transactionHash: 'A'.repeat(64) } } } },
        responses: operationResponses({ ...apiErrors,
          '200': jsonResponse('Confirmed, pending, failed, not_a_contribution, unavailable or unconfigured. Only confirmed carries a receipt; it proves no ownership or paid entitlement.', ref('VerificationResult'), examples.verification),
          '400': jsonResponse('Invalid body, unexpected fields, or missing/invalid transactionHash. Parser errors contain error only; validation failures include invalid_request.', ref('VerificationBadRequest'), examples.invalidVerification),
          '415': responseRef('UnsupportedMediaType'),
        }),
      } },
      '/healthz': { get: {
        operationId: 'health', summary: 'Application health (independent of chain availability)',
        responses: { '200': jsonResponse('Application is running, including when retired or when serving storage is unavailable. This GET bypasses API body parsing, origin checks and rate limits.', ref('Health'), examples.health) },
      } },
    },
    components: { schemas, responses },
  };
}
