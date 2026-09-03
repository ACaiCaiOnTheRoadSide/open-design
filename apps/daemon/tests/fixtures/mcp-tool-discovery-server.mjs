import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'discovery-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  if (request.params?.cursor === 'page-2') {
    return {
      tools: [{
        name: 'image_to_image',
        inputSchema: { type: 'object', properties: {} },
      }],
    };
  }
  return {
    tools: [{
      name: 'text_to_image',
      description: 'Generate an image',
      inputSchema: { type: 'object', properties: {} },
    }],
    nextCursor: 'page-2',
  };
});
await server.connect(new StdioServerTransport());
