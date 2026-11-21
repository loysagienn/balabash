export const COORDINATOR_AGENT = 'coordinator';

// The coordinator implements the contract statically in src/ — a dynamic
// agent must not shadow it in the catalog. 'secretary' is what prompts call
// the coordinator ('coordinator' stays the internal identifier in code, the
// event log and thread rows), so both names are off-limits.
export const RESERVED_AGENT_NAMES = new Set([COORDINATOR_AGENT, 'secretary']);
