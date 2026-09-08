export type ProposalFeeAdjustmentProgram = {
  currency?: string | null;
  serviceFeeAmount?: number | null;
};

export type ProposalFeeAdjustmentContext = {
  currency: string;
  currencies: string[];
  hasMultipleCurrencies: boolean;
  sampleFee: number;
};

function normalizeCurrency(currency: string | null | undefined): string {
  const normalized = currency?.trim().toUpperCase();
  return normalized || "USD";
}

/**
 * A flat monetary adjustment is only meaningful when every selected program
 * uses the same currency. Keep this decision outside the modal so both the
 * opening preview and the final PDF generation can use the same contract.
 */
export function getProposalFeeAdjustmentContext(
  programs: ProposalFeeAdjustmentProgram[],
): ProposalFeeAdjustmentContext {
  const currencies = [...new Set(programs.map((program) => normalizeCurrency(program.currency)))];
  const sampleFee = programs
    .map((program) => program.serviceFeeAmount)
    .find((amount): amount is number => amount != null && Number.isFinite(amount) && amount > 0) ?? 0;

  return {
    currency: currencies.length === 1 ? currencies[0] : "USD",
    currencies,
    hasMultipleCurrencies: currencies.length > 1,
    sampleFee,
  };
}
