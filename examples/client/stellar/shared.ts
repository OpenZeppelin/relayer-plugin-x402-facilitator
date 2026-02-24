import { Api } from "@stellar/stellar-sdk/rpc";

/**
 * Handles the simulation result of a Stellar transaction.
 *
 * @param simulation - The simulation result to handle
 * @throws An error if the simulation result is of type "RESTORE" or "ERROR"
 */
export function handleSimulationResult(simulation?: Api.SimulateTransactionResponse) {
  if (!simulation) {
    throw new Error("Simulation result is undefined");
  }

  if (Api.isSimulationRestore(simulation)) {
    throw new Error(
      `Stellar simulation result has type "RESTORE" with restorePreamble: ${simulation.restorePreamble}`,
    );
  }

  if (Api.isSimulationError(simulation)) {
    const msg = `Stellar simulation failed${simulation.error ? ` with error message: ${simulation.error}` : ""}`;

    throw new Error(msg);
  }
}
