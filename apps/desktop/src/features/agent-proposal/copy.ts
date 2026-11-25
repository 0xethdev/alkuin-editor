/**
 * Lines for an addition an AI chat sent through the Alkuin connector.
 */

/** The card's label, after the AI badge. The chat's own name is not known here. */
export const AGENT_CARD_LABEL = "From your AI chat";

const ARRIVED_ONE = "Your AI chat suggested an addition to {document}.";
const ARRIVED_SOME = "Your AI chat suggested additions to {count} documents.";

/**
 * One line for the suggestions a pull just brought, by the documents they are
 * for. One document is always named, however many suggestions it has. The
 * counted line is for two or more, so it never reads "1 documents".
 */
export function agentArrivalLine(documents: readonly string[]): string {
  if (documents.length < 2) return ARRIVED_ONE.replace("{document}", documents[0] ?? "");
  return ARRIVED_SOME.replace("{count}", String(documents.length));
}
