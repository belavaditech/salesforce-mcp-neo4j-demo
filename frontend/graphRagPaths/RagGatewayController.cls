
/**
 * RagGatewayController.cls 
 * Apex controller to make authenticated HTTP callout to MCP Gateway.
 * Uses Named Credential: RagNeo4jGateway
 */
public with sharing class RagGatewayController {
    @AuraEnabled(cacheable=false)
    public static Map<String, Object> getMcpResponse(String input, String mode) {
        Http http = new Http();
        HttpRequest req = new HttpRequest();
        String endpoint = 'callout:RagNeo4jGateway/' + mode;  // mode = method1, method2, no-rag
        req.setEndpoint(endpoint);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');

        Map<String,Object> payload = new Map<String,Object>{
            'naturalLanguage' => input
        };
        req.setBody(JSON.serialize(payload));

        HttpResponse res = http.send(req);
        if (res.getStatusCode() == 200) {
            return (Map<String,Object>) JSON.deserializeUntyped(res.getBody());
        } else {
            throw new AuraHandledException('Gateway error – Status Code: ' + res.getStatusCode());
        }
    }
}
