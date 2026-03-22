import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import jwt from 'jsonwebtoken';
import type { ObjectId } from 'mongodb';
import { authConfig } from '../config.js';
import refreshTokensDAO from '../dataAccess/refreshTokensDAO.js';
import usersDAO from '../dataAccess/usersDAO.js';
import type { UsersPayload } from '../types/authTypes.js';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from './constants.js';

export type OAuthProfile = {
    email: string;
    firstName: string;
    lastName: string;
    picture?: string;
};

export type ProviderToken = {
    provider: string;
    accessToken: string;
    refreshToken?: string;
    expiresIn: number; // seconds; 0 means no expiry info (e.g. GitHub long-lived tokens)
};

export function setAuthCookies(c: Context, accessTokenValue: string, refreshTokenValue: string) {
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
    const nodeEnv = process.env['NODE_ENV'];
    if (nodeEnv === 'production') {
        // sameSite: 'None' + secure required when client (Cloudflare Pages) and API (Cloud Run) are on different domains
        setCookie(c, ACCESS_TOKEN_COOKIE, accessTokenValue, { httpOnly: true, secure: true, sameSite: 'None', path: '/', maxAge: 15 * 60 });
        setCookie(c, REFRESH_TOKEN_COOKIE, refreshTokenValue, { httpOnly: true, secure: true, sameSite: 'None', path: '/', maxAge: 30 * 24 * 60 * 60 });
    } else {
        setCookie(c, ACCESS_TOKEN_COOKIE, accessTokenValue, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 15 * 60 });
        setCookie(c, REFRESH_TOKEN_COOKIE, refreshTokenValue, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 30 * 24 * 60 * 60 });
    }
}

/** Find-or-create user by email; push/replace the provider token in their tokens[] array. */
export async function upsertUserByEmail(profile: OAuthProfile, providerToken: ProviderToken): Promise<ObjectId> {
    const now = dayjs().toISOString();

    const result = await usersDAO.collection.findOneAndUpdate(
        { email: profile.email },
        {
            $setOnInsert: { email: profile.email, createdTs: now },
            $set: { updatedTs: now, firstName: profile.firstName, lastName: profile.lastName, ...(profile.picture ? { picture: profile.picture } : {}) },
        },
        { upsert: true, returnDocument: 'after' },
    );

    // Replace provider token entry (pull old, push fresh)
    await usersDAO.updateOne({ email: profile.email }, { $pull: { tokens: { provider: providerToken.provider } } });
    await usersDAO.updateOne(
        { email: profile.email },
        {
            $push: {
                tokens: {
                    provider: providerToken.provider,
                    accessToken: providerToken.accessToken,
                    refreshToken: providerToken.refreshToken ?? '',
                    expireTs: providerToken.expiresIn > 0 ? dayjs().add(providerToken.expiresIn, 'seconds').toISOString() : '', // GitHub tokens have no expiry; Google always provides expires_in
                },
            },
        },
    );

    if (!result?._id) throw new Error(`Could not upsert user ${profile.email}`);
    return result._id;
}

export async function issueRefreshToken(userId: ObjectId, email: string): Promise<string> {
    const token = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    await refreshTokensDAO.insertOne({ token, userId, email, expiresAt, createdAt: now });
    return token;
}

export function signAccessToken(userId: string, email: string): string {
    const payload: UsersPayload = { contents: [{ id: userId, email }] };
    return jwt.sign(payload, authConfig.jwtSecret, { expiresIn: '15m' });
}
