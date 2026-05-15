import { randomBytes } from 'node:crypto';

// Animal-hash slugs for grove/<animal>-<4hex> branch names. Aim is "memorable
// enough to tell two forks apart in a sidebar," not unique identifiers — the
// 4-char hex suffix carries the uniqueness.
const ANIMALS = [
  'otter', 'crane', 'falcon', 'lynx', 'heron', 'bison', 'gecko', 'panda',
  'moose', 'raven', 'viper', 'koala', 'dingo', 'tapir', 'quokka', 'axolotl',
  'marmot', 'ibis', 'stoat', 'okapi', 'badger', 'beaver', 'caribou', 'cheetah',
  'condor', 'coyote', 'dolphin', 'eagle', 'ferret', 'finch', 'gibbon', 'hare',
  'iguana', 'jackal', 'jaguar', 'kestrel', 'lemur', 'magpie', 'manatee', 'mink',
  'narwhal', 'newt', 'ocelot', 'oryx', 'osprey', 'pangolin', 'plover', 'puffin',
  'quail', 'rabbit', 'salmon', 'serval', 'sloth', 'tiger', 'toucan', 'turtle',
  'vicuna', 'walrus', 'weasel', 'wombat',
];

export function generateBranchName(): string {
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const hash = randomBytes(2).toString('hex');
  return `grove/${animal}-${hash}`;
}

export function displayName(branch: string): string {
  return branch.startsWith('grove/') ? branch.slice('grove/'.length) : branch;
}
