import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// requirePossessionProof = true: only accounts registered with register-key-v2 (proof of possession) can anchor.
export default buildModule("AnchorRegistryModule", (m) => {
  const registry = m.contract("AnchorRegistry", [m.getParameter("requirePossessionProof", true)]);
  return { registry };
});
