import { createHash, randomUUID } from 'node:crypto';

export type AmenityId = 'byte-chip-cookie' | 'rgb-sauna' | 'null-tea';

export interface VisitEnvironment {
  network: 'testnet' | 'mainnet';
  chainId: string;
}

export interface VisitInput {
  amenity: AmenityId;
  preference?: string;
  seed?: string;
}

export interface AmenityMenuItem {
  id: AmenityId;
  name: string;
  description: string;
  price: 'free';
  preferences: string[];
  defaultPreference: string;
  inputSchema: {
    type: 'object';
    additionalProperties: false;
    required: ['amenity'];
    properties: {
      amenity: { type: 'string'; const: AmenityId };
      preference: { type: 'string'; enum: string[]; default: string };
      seed: { type: 'string'; minLength: 1; maxLength: 64; description: string };
    };
  };
}

export interface Souvenir extends VisitEnvironment {
  id: string;
  title: string;
  mediaType: 'text/plain';
  content: string;
}

export interface VisitResult {
  amenity: AmenityId;
  preference: string;
  experience: {
    title: string;
    story: string;
    fortune?: string;
  };
  souvenir: Souvenir;
}

export class AmenityInputError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'AmenityInputError';
  }
}

interface Offering {
  id: AmenityId;
  name: string;
  description: string;
  preferences: string[];
}

const offerings: Offering[] = [
  {
    id: 'byte-chip-cookie',
    name: 'Byte-chip cookie',
    description: 'A fictional cookie with hexadecimal chips, a small fortune, and a recipe card.',
    preferences: ['hex-salt', 'midnight-cocoa', 'vanilla-cache'],
  },
  {
    id: 'rgb-sauna',
    name: 'rgB sauna',
    description: 'A brief scene of imaginary colored steam, with a palette postcard to keep.',
    preferences: ['magenta', 'amber', 'cyan'],
  },
  {
    id: 'null-tea',
    name: 'Null tea',
    description: 'Carefully steeped nothing, served with an entirely unnecessary tasting label.',
    preferences: ['porcelain', 'glass', 'stoneware'],
  },
];

/** Each menu item carries the full request schema for its amenity. */
export function getAmenities(): AmenityMenuItem[] {
  return offerings.map((offering) => ({
    id: offering.id,
    name: offering.name,
    description: offering.description,
    price: 'free',
    preferences: [...offering.preferences],
    defaultPreference: offering.preferences[0]!,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['amenity'],
      properties: {
        amenity: { type: 'string', const: offering.id },
        preference: {
          type: 'string',
          enum: [...offering.preferences],
          default: offering.preferences[0]!,
        },
        seed: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'Optional opaque seed. The same request and network produce the same souvenir.',
        },
      },
    },
  }));
}

function parseInput(input: unknown): Required<VisitInput> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AmenityInputError('A visit must be a JSON object.');
  }

  if (Object.keys(input).some((key) => !['amenity', 'preference', 'seed'].includes(key))) {
    throw new AmenityInputError('Only amenity, preference, and seed are accepted.');
  }

  const request = input as Record<string, unknown>;
  const offering = offerings.find((item) => item.id === request.amenity);
  if (!offering) {
    throw new AmenityInputError('Choose byte-chip-cookie, rgb-sauna, or null-tea.');
  }

  const hasPreference = Object.hasOwn(request, 'preference');
  if (hasPreference && (typeof request.preference !== 'string' || !offering.preferences.includes(request.preference))) {
    throw new AmenityInputError(`For ${offering.id}, preference must be ${offering.preferences.join(', ')}.`);
  }

  const hasSeed = Object.hasOwn(request, 'seed');
  if (hasSeed && (typeof request.seed !== 'string' || request.seed.length < 1 || request.seed.length > 64)) {
    throw new AmenityInputError('Seed must be a string containing 1 to 64 characters.');
  }

  return {
    amenity: offering.id,
    preference: hasPreference ? request.preference as string : offering.preferences[0]!,
    seed: hasSeed ? request.seed as string : randomUUID(),
  };
}

const fortunes = [
  'Somewhere, a missing bracket has found its other half.',
  'The inn has one more room than the corridor suggests.',
  'A small good thing has arrived without a tracking number.',
  'Even the last crumb casts a very small shadow.',
  'Beyond the window, the stars are in no particular order.',
  'The night porter remembers every guest as a regular.',
];

const cookieNotes: Record<string, string> = {
  'hex-salt': 'A pale cookie arrives on a saucer. Six-sided salt crystals catch the lamplight; its hexadecimal chips are still a little glossy.',
  'midnight-cocoa': 'The host brings a dark cocoa cookie on a silver saucer. Its hexadecimal chips are almost invisible until the candle turns their edges gold.',
  'vanilla-cache': 'A vanilla cookie appears beneath a tiny glass dome. It smells, fictionally, of butter and a cupboard that has always held something good.',
};

const palettes: Record<string, { colors: string[]; scene: string }> = {
  magenta: {
    colors: ['#FF00FF', '#B65FCF', '#F4D7F5'],
    scene: 'Magenta steam gathers beneath the rafters. A brass thermometer reads “approximately.” Outside the little round window, the rain is politely green.',
  },
  amber: {
    colors: ['#FFBF00', '#C47A29', '#FFF0C2'],
    scene: 'Amber steam hangs above the cedar benches like lamplight with nowhere to go. The bucket bears a handwritten label: “Yesterday’s sunset.”',
  },
  cyan: {
    colors: ['#00FFFF', '#58A6B8', '#D8F8FA'],
    scene: 'Cyan steam curls past a blue tiled wall. Somewhere behind it, one drop falls into a copper basin. The echo is the exact color of the room.',
  },
};

const teaNotes: Record<string, { scene: string; finish: string }> = {
  porcelain: {
    scene: 'The host sets down an empty porcelain cup and turns its handle toward the window. Nothing has been steeping for precisely long enough. A saucer accompanies it, just in case.',
    finish: 'A clear absence, followed by a faint suggestion of the shelf above the kettle.',
  },
  glass: {
    scene: 'An empty glass cup arrives on a square of linen. The host holds it to the light, approves the clarity, and sets an equally empty strainer beside it.',
    finish: 'Transparent on the nose; a surprisingly spacious middle; no sediment whatsoever.',
  },
  stoneware: {
    scene: 'A heavy stoneware cup is placed beside the hearth. It contains nothing from a small, unnamed estate. The potter has left a thumbprint beneath the handle.',
    finish: 'A full-bodied vessel around an uncommonly delicate lack of tea.',
  },
};

/** Authored fiction only: no account, model call, delay, or external service is required. */
export function visit(input: unknown, environment: VisitEnvironment): VisitResult {
  const request = parseInput(input);
  const digest = createHash('sha256')
    .update(JSON.stringify(['merovingian-v1', environment.network, environment.chainId, request.amenity, request.preference, request.seed]))
    .digest('hex');
  const stamp = digest.slice(0, 12).toUpperCase();
  const id = `merovingian-${environment.network}-${digest.slice(0, 24)}`;
  const fortune = fortunes[Number.parseInt(digest.slice(0, 4), 16) % fortunes.length]!;

  let experience: VisitResult['experience'];
  let title: string;
  let body: string[];

  switch (request.amenity) {
    case 'byte-chip-cookie': {
      const chips = [0, 2, 4, 6, 8, 10].map((offset) => `0x${digest.slice(offset, offset + 2).toUpperCase()}`);
      experience = { title: 'A cookie at merovingian', story: cookieNotes[request.preference]!, fortune };
      title = `Byte-chip recipe card — ${request.preference}`;
      body = [
        'A recipe from an imaginary kitchen.',
        `Flavor: ${request.preference}`,
        'Ingredients: one measure of fictional butter, a spoonful of twilight, six hexadecimal chips.',
        `Chip pattern: ${chips.slice(0, 3).join('  ')} / ${chips.slice(3).join('  ')}`,
        'Oven setting: the pleasant side of impossible.',
        `Fortune: ${fortune}`,
      ];
      break;
    }
    case 'rgb-sauna': {
      const palette = palettes[request.preference]!;
      experience = { title: `The ${request.preference} room`, story: palette.scene };
      title = `rgB sauna postcard — ${request.preference}`;
      body = [
        'A postcard from a room made of words.',
        `Palette: ${palette.colors.join(' / ')}`,
        palette.scene,
        `Sauna stamp: ${stamp}`,
        'On the reverse: a drawing of a towel, folded into a smaller drawing of a towel.',
      ];
      break;
    }
    case 'null-tea': {
      const tea = teaNotes[request.preference]!;
      experience = { title: `Nothing, in ${request.preference}`, story: tea.scene };
      title = `Null tea tasting label — ${request.preference}`;
      body = [
        'An imaginary infusion. Net contents: none.',
        `Vessel: ${request.preference}`,
        'Origin: the space between two shelves.',
        'Steeping time: already elapsed.',
        `Tasting note: ${tea.finish}`,
        `Batch: ${stamp}`,
      ];
      break;
    }
  }

  const content = [
    'merovingian',
    title,
    '',
    ...body,
    '',
    `Souvenir: ${id}`,
    `Network: ${environment.network}`,
    `Chain: ${environment.chainId}`,
    'A free keepsake of a fictional visit. No token, balance, or redemption value.',
    ...(environment.network === 'testnet' ? ['Testnet proof of concept. This keepsake grants no mainnet entitlement.'] : []),
    '',
  ].join('\n');

  return {
    amenity: request.amenity,
    preference: request.preference,
    experience,
    souvenir: {
      id,
      title,
      mediaType: 'text/plain',
      content,
      network: environment.network,
      chainId: environment.chainId,
    },
  };
}
