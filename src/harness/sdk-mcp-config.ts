import { MAX_RUN_PROGRAM_SECONDS } from '../catalog/actions.ts';

export const BRIDGE_SERVER = 'balabash';
// Leave time for the program's teardown, journal entry and reply.
export const CATALOG_CALL_TIMEOUT_SECONDS = MAX_RUN_PROGRAM_SECONDS + 60;
