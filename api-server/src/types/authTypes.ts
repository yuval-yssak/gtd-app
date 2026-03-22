import type { JwtPayload } from 'jsonwebtoken';

export interface UserPayload {
    id: string;
    email: string;
}

export type UsersPayload = { contents: UserPayload[] };

export interface JwtUsersPayload extends JwtPayload, UsersPayload {}

// Hono context variable typing — replaces Express's req.users pattern
export type AuthVariables = { users: JwtUsersPayload };
