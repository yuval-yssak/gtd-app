import Button from "@mui/material/Button";
import { GTDMainComponent } from "../components/basic/GTDComponentBlocks";
// import { useEffect, useState } from "react";
// import { x } from "../loaders/axios";

// type ClarifyForm = {
//     text: string;
//     workContexts: string[];
//     selectedWorkContexts: string[];
//     people: { name: string; age: number }[];
// };
export function ClarifyPage() {
  // const [oneItemText, setOneItemText] = useState("");
  // useEffect(() => {
  //     x.get("/items?status=inbox").then((r) => setOneItemText(r.data[0]?.title));
  // }, []);

  // const textFromServer = oneItemText;
  // const { Field, handleSubmit, pushFieldValue, useStore } = useForm<ClarifyForm>({
  //     onSubmit: async ({ value }) => {
  //         console.log({ value });
  //     },
  //     defaultValues: { text: textFromServer, workContexts: ["laptop", "phone"], people: [], selectedWorkContexts: [] },
  // });
  // const swc = useStore((s) => s.values.selectedWorkContexts);
  return (
    <GTDMainComponent>
      <h2>Clarify</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // handleSubmit();
        }}
      >
        {/* <TextField
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                    autoFocus
                    multiline
                    placeholder="What is it"
                />
                <Stack direction="row">
                    <Chip
                        label={subField.state.value}
                        onClick={() => {
                            if (!swc.includes(c)) pushFieldValue("selectedWorkContexts", c);
                        }}
                    />
                </Stack> */}
        <Button type="submit">Submits</Button>
      </form>
    </GTDMainComponent>
  );
}

// {workContexts.map((c) => (
//
// ))} */}
