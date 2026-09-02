/** Pi provider slug for SuperGrok subscription models (`pi/xai-oauth/<model>`).
 * Kept apart from the API-key `xai` provider so per-token billing and the
 * subscription pool never share a credential path. Its own module so the model
 * registry and the account pool can both name it without importing each other. */
export const XAI_OAUTH_PROVIDER = "xai-oauth";
