import axios from "axios";
import { BASE_SERVER_URL } from "../constants/globals";

export const x = axios.create({ baseURL: BASE_SERVER_URL });
