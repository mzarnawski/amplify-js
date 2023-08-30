// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
	AuthTokens,
	FetchAuthSessionOptions,
	AuthConfig,
	Hub,
} from '@aws-amplify/core';
import {
	AMPLIFY_SYMBOL,
	assertTokenProviderConfig,
	isTokenExpired,
} from '@aws-amplify/core/internals/utils';
import {
	AuthTokenOrchestrator,
	AuthTokenStore,
	CognitoAuthTokens,
	TokenRefresher,
} from './types';

export class TokenOrchestrator implements AuthTokenOrchestrator {
	private authConfig: AuthConfig;

	tokenStore: AuthTokenStore;
	tokenRefresher: TokenRefresher;
	waitForInflightOAuth: () => Promise<void> = async () => {};

	setAuthConfig(authConfig: AuthConfig) {
		this.authConfig = authConfig;
	}
	setTokenRefresher(tokenRefresher: TokenRefresher) {
		this.tokenRefresher = tokenRefresher;
	}
	setAuthTokenStore(tokenStore: AuthTokenStore) {
		this.tokenStore = tokenStore;
	}
	setWaitForInflightOAuth(waitForInflightOAuth: () => Promise<void>) {
		this.waitForInflightOAuth = waitForInflightOAuth;
	}

	async getTokens(
		options?: FetchAuthSessionOptions
	): Promise<AuthTokens | null> {
		let tokens: CognitoAuthTokens;
		try {
			assertTokenProviderConfig(this.authConfig.Cognito);
		} catch (_err) {
			// Token provider not configured
			return null;
		}
		await this.waitForInflightOAuth();
		tokens = await this.tokenStore.loadTokens();

		if (tokens === null) {
			return null;
		}
		const idTokenExpired =
			!!tokens?.idToken &&
			isTokenExpired({
				expiresAt: (tokens.idToken?.payload?.exp || 0) * 1000,
				clockDrift: tokens.clockDrift || 0,
			});
		const accessTokenExpired = isTokenExpired({
			expiresAt: (tokens.accessToken?.payload?.exp || 0) * 1000,
			clockDrift: tokens.clockDrift || 0,
		});

		if (options?.forceRefresh || idTokenExpired || accessTokenExpired) {
			tokens = await this.refreshTokens({
				tokens,
			});

			if (tokens === null) {
				return null;
			}
		}

		return {
			accessToken: tokens?.accessToken,
			idToken: tokens?.idToken,
		};
	}

	private async refreshTokens({
		tokens,
	}: {
		tokens: CognitoAuthTokens;
	}): Promise<CognitoAuthTokens | null> {
		try {
			const newTokens = await this.tokenRefresher({
				tokens,
				authConfig: this.authConfig,
			});

			this.setTokens({ tokens: newTokens });
			Hub.dispatch('auth', { event: 'tokenRefresh' }, 'Auth', AMPLIFY_SYMBOL);

			return newTokens;
		} catch (err) {
			return this.handleErrors(err);
		}
	}

	private handleErrors(err: Error) {
		if (err.message !== 'Network error') {
			// TODO(v6): Check errors on client
			this.clearTokens();
		}
		if (err.name.startsWith('NotAuthorizedException')) {
			return null;
		} else {
			Hub.dispatch(
				'auth',
				{ event: 'tokenRefresh_failure' },
				'Auth',
				AMPLIFY_SYMBOL
			);
			throw err;
		}
	}
	async setTokens({ tokens }: { tokens: CognitoAuthTokens }) {
		return this.tokenStore.storeTokens(tokens);
	}

	async clearTokens() {
		return this.tokenStore.clearTokens();
	}
}
