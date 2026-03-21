import { createFileRoute } from '@tanstack/react-router'
import { ItemPage } from '../../../Pages/ItemPage'

export const Component = () => {
  const { id } = Route.useParams()
  return <ItemPage id={id} />
}

export const Route = createFileRoute('/_authenticated/items/$id')({
  component: Component,
})
