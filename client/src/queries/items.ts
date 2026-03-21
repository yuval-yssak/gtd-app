import { x } from "../loaders/axios";
import { ItemInterface } from "../types/entities";

export async function queryInbox() {
  const search = new URLSearchParams();
  search.append("status", "inbox" satisfies ItemInterface["status"]);

  const response = await x.get<ItemInterface[]>("/items?" + search.toString());
  return response.data;
}
