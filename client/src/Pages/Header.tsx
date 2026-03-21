import styled from "@emotion/styled";
import { Link } from "@tanstack/react-router";

const HeaderDiv = styled.div`
  background-color: gold;
`;

const Flex = styled.div`
  display: flex;
  gap: 1rem;
  padding: 0.5rem;
`;

export function Header() {
  return (
    <HeaderDiv id="header">
      <h2>Header</h2>
      <Flex>
        <Link to="/collect">Collect</Link>
        <Link to="/clarify">Clarify</Link>
        <Link to="/lists/inbox">Inbox</Link>
        <Link to="/login">Login</Link>
      </Flex>
    </HeaderDiv>
  );
}
