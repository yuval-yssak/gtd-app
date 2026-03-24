import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import type { AuthVariables } from '../types/authTypes.js';
import type { ItemInterface } from '../types/entities.js';

export const itemsRoutes = new Hono<{ Variables: AuthVariables }>()
    .post('/', authenticateRequest, async (c) => {
        const body = await c.req.json<{ _id: string; title: string; status?: ItemInterface['status']; createdTs?: string }>();
        const { user } = c.get('session');

        // _id is client-generated UUID so the same item can be created idempotently during sync replay
        await itemsDAO.insertOne({
            _id: body._id,
            createdTs: body.createdTs ?? new Date().toISOString(),
            status: body.status ?? 'inbox',
            title: body.title,
            user: user.id,
        });
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
    })
    .put('/:id', authenticateRequest, async (c) => {
        const { id } = c.req.param();
        const { user } = c.get('session');
        const body = await c.req.json<Partial<Omit<ItemInterface, '_id' | 'user'>>>();

        // Filter by user so one user can never overwrite another's item.
        // `as any` works around MongoDB driver's InferIdType widening _id to ObjectId when _id is
        // declared optional — at runtime _id is always a UUID string.
        await itemsDAO.updateOne({ _id: id, user: user.id } as any, { $set: body });
        return c.json({ ok: true });
    })
    .delete('/:id', authenticateRequest, async (c) => {
        const { id } = c.req.param();
        const { user } = c.get('session');

        // Filter by user so one user can never delete another's item. Same as any cast as PUT above.
        await itemsDAO.collection.deleteOne({ _id: id, user: user.id } as any);
        return c.json({ ok: true });
    });
