import { z } from "zod";
import { setSessionCookie } from "../../cookies";
import type { OAuth2Tokens } from "../../oauth2";
import { handleOAuthUserInfo } from "../../oauth2/link-account";
import { parseState } from "../../oauth2/state";
import { HIDE_METADATA } from "../../utils/hide-metadata";
import { createAuthEndpoint } from "../call";

const schema = z.object({
	code: z.string().optional(),
	error: z.string().optional(),
	error_description: z.string().optional(),
	state: z.string().optional(),
});

export const callbackOAuth = createAuthEndpoint(
	"/callback/:id",
	{
		method: ["GET", "POST"],
		body: schema.optional(),
		query: schema.optional(),
		metadata: HIDE_METADATA,
	},
	async (c) => {
		let queryOrBody: z.infer<typeof schema>;
		try {
			if (c.method === "GET") {
				queryOrBody = schema.parse(c.query);
			} else if (c.method === "POST") {
				queryOrBody = schema.parse(c.body);
			} else {
				throw new Error("Unsupported method");
			}
		} catch (e) {
			c.context.logger.error("INVALID_CALLBACK_REQUEST", e);
			throw c.redirect(
				`${c.context.baseURL}/error?error=invalid_callback_request`,
			);
		}

		const { code, error, state, error_description } = queryOrBody;

		if (!state) {
			c.context.logger.error("State not found", error);
			throw c.redirect(`${c.context.baseURL}/error?error=state_not_found`);
		}

		if (!code) {
			c.context.logger.error("Code not found");
			throw c.redirect(
				`${c.context.baseURL}/error?error=${
					error || "no_code"
				}&error_description=${error_description}`,
			);
		}
		const provider = c.context.socialProviders.find(
			(p) => p.id === c.params.id,
		);

		if (!provider) {
			c.context.logger.error(
				"Oauth provider with id",
				c.params.id,
				"not found",
			);
			throw c.redirect(
				`${c.context.baseURL}/error?error=oauth_provider_not_found`,
			);
		}
		const { codeVerifier, callbackURL, link, errorURL, newUserURL } =
			await parseState(c);

		let tokens: OAuth2Tokens;
		try {
			tokens = await provider.validateAuthorizationCode({
				code: code,
				codeVerifier,
				redirectURI: `${c.context.baseURL}/callback/${provider.id}`,
			});
		} catch (e) {
			c.context.logger.error("", e);
			throw c.redirect(
				`${c.context.baseURL}/error?error=please_restart_the_process`,
			);
		}
		const userInfo = await provider
			.getUserInfo(tokens)
			.then((res) => res?.user);

		function redirectOnError(error: string) {
			let url = errorURL || callbackURL || `${c.context.baseURL}/error`;
			if (url.includes("?")) {
				url = `${url}&error=${error}`;
			} else {
				url = `${url}?error=${error}`;
			}
			throw c.redirect(url);
		}
		if (!userInfo) {
			c.context.logger.error("Unable to get user info");
			return redirectOnError("unable_to_get_user_info");
		}

		if (!userInfo.email) {
			userInfo.email = `unset@unset-email.net`;
		}
		
		if (!callbackURL) {
			c.context.logger.error("No callback URL found");
			throw c.redirect(
				`${c.context.baseURL}/error?error=please_restart_the_process`,
			);
		}
		if (link) {
			if (
				c.context.options.account?.accountLinking?.allowDifferentEmails !==
					true &&
				link.email !== userInfo.email.toLowerCase()
			) {
				return redirectOnError("email_doesn't_match");
			}
			const existingAccount = await c.context.internalAdapter.findAccount(
				userInfo.id,
			);
			if (existingAccount) {
				if (existingAccount && existingAccount.userId !== link.userId) {
					return redirectOnError("account_already_linked_to_different_user");
				}
				return redirectOnError("account_already_linked");
			}
			const newAccount = await c.context.internalAdapter.createAccount({
				userId: link.userId,
				providerId: provider.id,
				accountId: userInfo.id,
				...tokens,
				scope: tokens.scopes?.join(","),
			});
			if (!newAccount) {
				return redirectOnError("unable_to_link_account");
			}
			let toRedirectTo: string;
			try {
				const url = callbackURL;
				toRedirectTo = url.toString();
			} catch {
				toRedirectTo = callbackURL;
			}
			throw c.redirect(toRedirectTo);
		}

		const result = await handleOAuthUserInfo(c, {
			userInfo: {
				...userInfo,
				email: userInfo.email,
				name: userInfo.name || userInfo.email,
			},
			account: {
				providerId: provider.id,
				accountId: userInfo.id,
				...tokens,
				scope: tokens.scopes?.join(","),
			},
			callbackURL,
		});
		if (result.error) {
			c.context.logger.error(result.error.split(" ").join("_"));
			return redirectOnError(result.error.split(" ").join("_"));
		}
		const { session, user } = result.data!;
		await setSessionCookie(c, {
			session,
			user,
		});
		let toRedirectTo: string;
		try {
			const url = result.isRegister ? newUserURL || callbackURL : callbackURL;
			toRedirectTo = url.toString();
		} catch {
			toRedirectTo = result.isRegister
				? newUserURL || callbackURL
				: callbackURL;
		}
		throw c.redirect(toRedirectTo);
	},
);
