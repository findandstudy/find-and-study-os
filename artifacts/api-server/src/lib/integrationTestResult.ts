export type IntegrationTestStatus = "verified" | "failed" | "simulated" | "not_supported";

export type IntegrationTestResult = {
  success: boolean;
  verified: boolean;
  simulated: boolean;
  status: IntegrationTestStatus;
  message: string;
};

export function simulatedIntegrationTestResult(message: string): IntegrationTestResult {
  return { success: false, verified: false, simulated: true, status: "simulated", message };
}

export function unsupportedIntegrationTestResult(message: string): IntegrationTestResult {
  return { success: false, verified: false, simulated: false, status: "not_supported", message };
}
