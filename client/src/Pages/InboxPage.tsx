import List from "@mui/material/List";
import { GTDItemListItem } from "../components/GTDItemListItem";

export function InboxPage() {
    const { data, isLoading } = useSuspenseQuery(inboxQueryOptions);

    if (isLoading) {
        return <>Loading...</>;
    }
    return (
        <>
            <h2>Inbox</h2>
            <List>
                {data.map((item) => (
                    <GTDItemListItem key={item._id} item={item} />
                ))}
            </List>
        </>
    );
}