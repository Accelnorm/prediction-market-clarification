import { SolanaProvider } from "@solana/react-hooks";
import { PropsWithChildren } from "react";
import { autoDiscover, createClient, filterByNames } from "@solana/client";

const client = createClient({
  endpoint: "https://api.devnet.solana.com",
  walletConnectors: autoDiscover({
    filter: filterByNames("phantom", "solflare", "backpack"),
  }),
});

export function Providers({ children }: PropsWithChildren) {
  return <SolanaProvider client={client}>{children}</SolanaProvider>;
}
