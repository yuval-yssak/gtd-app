import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import type { AuthVariables } from '../types/authTypes.js';
import type { ItemInterface } from '../types/entities.js';

export const itemsRoutes = new Hono<{ Variables: AuthVariables }>()
    .post('/', authenticateRequest, async (c) => {
        const body = await c.req.json<{ title: string }>();
        const { user } = c.get('session');

        await itemsDAO.insertOne({ createdTs: dayjs().toISOString(), status: 'inbox', title: body.title, user: user.id });
        return c.json({ ok: true }, 201);
    })
    .get('/', authenticateRequest, async (c) => {
        const { user } = c.get('session');

        const status = c.req.query('status');
        const page = c.req.query('page');
        const limit = c.req.query('limit');
        const sort = c.req.query('sort'); // field name to sort by, e.g. 'createdTs'
        const direction = c.req.query('direction'); // 'asc' | 'desc'

        const sortValue: 1 | -1 = direction === 'desc' ? -1 : 1;
        const sortObj: Record<string, 1 | -1> | undefined = sort ? { [sort]: sortValue } : undefined;

        const list = await itemsDAO.findArray(
            {
                user: user.id,
                ...(status && { status: { $in: status.split(',') as ItemInterface['status'][] } }),
            },
            {
                ...(sortObj && { sort: sortObj }),
                ...(page !== undefined && !Number.isNaN(+page) && { skip: +page }),
                ...(limit !== undefined && !Number.isNaN(+limit) && { limit: +limit }),
            },
        );
        return c.json(list);
    });
