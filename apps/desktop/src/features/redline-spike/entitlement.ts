/** Accept and Reject work on Free. Free does not send a learn call.
 * A plan that has not loaded yet still sends one, so a paid writer keeps the lesson.
 * Signed out there is no token, and the learn command sends nothing.
 */
export function learnOnDecision(plan: string | null): boolean {
  return plan !== "free";
}
