import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import { ItemInterface } from "../types/entities";
import { Link } from "@tanstack/react-router";

export function GTDItemListItem({ item }: { item: ItemInterface }) {
  return (
    <ListItem title={item.title}>
      <Link to="/items/$id" params={{ id: item._id }}>
        <ListItemText>{item.title}</ListItemText>
      </Link>
    </ListItem>
  );
}
