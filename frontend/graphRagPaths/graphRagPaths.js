import { LightningElement, track } from 'lwc';
import getMcpResponse from '@salesforce/apex/RagGatewayController.getMcpResponse';

const COLUMNS = [
  { label: 'Case ID', fieldName: 'caseId' },
  { label: 'Product', fieldName: 'product' },
  { label: 'Supplier Path', fieldName: 'supplierPath' },
  { label: 'Total Cost', fieldName: 'totalCost', type: 'currency' },
  { label: 'Risk Index', fieldName: 'riskIndex', type: 'number' },
  { label: 'Time Delay (days)', fieldName: 'timeDelay', type: 'number' },
  { label: 'Quality Score', fieldName: 'qualityScore', type: 'number' }
];

export default class GraphRagPaths extends LightningElement {
  @track question = '';
  @track loading = false;
  @track results = [];
  columns = COLUMNS;

  handleQuestion(event) {
    this.question = event.target.value;
  }

  async runGateway(mode) {
    this.loading = true;
    try {
      const response = await getMcpResponse({ input: this.question, mode });
      const dataRows = response?.groundedAnswer?.rows || response?.graphData || [];
      this.results = dataRows.map((row, idx) => ({
        id: idx,
        caseId: row.caseId,
        product: row.product,
        supplierPath: row.supplierPath,
        totalCost: row.totalCost,
        riskIndex: row.riskIndex,
        timeDelay: row.timeDelay,
        qualityScore: row.qualityScore
      }));
    } catch (error) {
      this.results = [{ id: 0, caseId: '', product: '', supplierPath: '', totalCost: 0, riskIndex: 0, timeDelay: 0, qualityScore: 0, error: error.body?.message }];
    } finally {
      this.loading = false;
    }
  }

  runNoRag() {
    this.runGateway('no-rag');
  }

  runMethod1() {
    this.runGateway('method1');
  }

  runMethod2() {
    this.runGateway('method2');
  }
}
