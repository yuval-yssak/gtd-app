import { createFileRoute, redirect, Outlet } from '@tanstack/react-router'
import AppBar from '@mui/material/AppBar'
import Toolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import Box from '@mui/material/Box'
import { authClient } from '../lib/authClient'
import { AccountSwitcher } from '../components/AccountSwitcher'

export const Route = createFileRoute('/_authenticated')({
    beforeLoad: async () => {
        const { data: session } = await authClient.getSession()
        if (!session) {
            throw redirect({ to: '/login' })
        }
        // Return session so child routes can access it via Route.useRouteContext()
        return { session }
    },
    component: AuthenticatedLayout,
})

function AuthenticatedLayout() {
    const { db } = Route.useRouteContext()

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
            <AppBar position="static">
                <Toolbar>
                    <Typography variant="h6" sx={{ flexGrow: 1 }}>
                        GTD
                    </Typography>
                    <AccountSwitcher db={db} />
                </Toolbar>
            </AppBar>
            <Box component="main" sx={{ flexGrow: 1, p: 3 }}>
                <Outlet />
            </Box>
        </Box>
    )
}
