import { backfillCalibrationPositiveCases } from '../../src/v2_experiments.ts';
(async () => {
  const result = await backfillCalibrationPositiveCases({
    experimentId: '53761995-3341-4ca2-9af1-b63b9bace516',
    count: 30,
    preferredDomains: [
      'financial_planning',
      'software_troubleshooting',
      'message_drafting',
      'work_execution',
      'risk_safety_decisions',
      'battery_range_planning'
    ],
    preferredLenses: [
      'descriptive'
    ]
  });
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
