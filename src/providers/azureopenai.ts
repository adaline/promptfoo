import type {
  AssistantsClient,
  AssistantCreationOptions,
  FunctionDefinition,
  RunStepToolCallDetails,
  RunStepMessageCreationDetails,
} from '@azure/openai-assistants';
import invariant from 'tiny-invariant';
import { Gateway } from '@adaline/gateway';
import type {
  CompleteChatHandlerResponseType,
  GetEmbeddingsHandlerResponseType,
} from '@adaline/gateway';
import { Azure as GatewayAzure } from '@adaline/azure';

import { fetchWithCache, isCacheEnabled } from '../cache';
import { getEnvString, getEnvFloat, getEnvInt } from '../envars';
import logger from '../logger';
import type {
  ApiProvider,
  CallApiContextParams,
  CallApiOptionsParams,
  EnvOverrides,
  ProviderEmbeddingResponse,
  ProviderResponse,
} from '../types';
import { maybeLoadFromExternalFile, renderVarsInObject } from '../util';
import { REQUEST_TIMEOUT_MS, parseChatPrompt, toTitleCase, calculateCost } from './shared';

interface AzureOpenAiCompletionOptions {
  // Azure identity params
  azureClientId?: string;
  azureClientSecret?: string;
  azureTenantId?: string;
  azureAuthorityHost?: string;
  azureTokenScope?: string;

  // Azure cognitive services params
  deployment_id?: string;
  dataSources?: any;

  // Promptfoo supported params
  apiHost?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  apiKeyEnvar?: string;
  apiVersion?: string;

  // OpenAI params
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  best_of?: number;
  functions?: {
    name: string;
    description?: string;
    parameters: any;
  }[];
  function_call?: 'none' | 'auto' | { name: string };
  tools?: {
    type: string;
    function: {
      name: string;
      description?: string;
      parameters: any;
    };
  }[];
  tool_choice?: 'none' | 'auto' | { type: 'function'; function?: { name: string } };
  response_format?: { type: 'json_object' };
  stop?: string[];
  seed?: number;

  passthrough?: object;
}

const AZURE_OPENAI_MODELS = [
  {
    id: 'gpt-4o-2024-08-06',
    cost: {
      input: 2.5 / 1000000,
      output: 10 / 1000000,
    },
  },
  {
    id: 'gpt-4o',
    cost: {
      input: 5 / 1000000,
      output: 15 / 1000000,
    },
  },
  {
    id: 'gpt-4o-mini',
    cost: {
      input: 0.15 / 1000000,
      output: 0.6 / 1000000,
    },
  },
  {
    id: 'gpt-3.5-turbo-0125',
    cost: {
      input: 0.5 / 1000000,
      output: 1.5 / 1000000,
    },
  },
  {
    id: 'gpt-3.5-turbo-instruct',
    cost: {
      input: 1.5 / 1000000,
      output: 2 / 1000000,
    },
  },
  {
    id: 'gpt-4',
    cost: {
      input: 30 / 1000000,
      output: 60 / 1000000,
    },
  },
  {
    id: 'gpt-4-32k',
    cost: {
      input: 60 / 1000000,
      output: 120 / 1000000,
    },
  },
  {
    id: 'babbage-002',
    cost: {
      input: 0.4 / 1000000,
      output: 0.4 / 1000000,
    },
  },
  {
    id: 'davinci-002',
    cost: {
      input: 2 / 1000000,
      output: 2 / 1000000,
    },
  },
  {
    id: 'text-embedding-ada-002',
    cost: {
      input: 0.1 / 1000000,
      output: 0.1 / 1000000,
    },
  },
  {
    id: 'text-embedding-3-large',
    cost: {
      input: 0.13 / 1000000,
      output: 0.13 / 1000000,
    },
  },
  {
    id: 'text-embedding-3-small',
    cost: {
      input: 0.02 / 1000000,
      output: 0.02 / 1000000,
    },
  },
  // Legacy models
  {
    id: 'gpt-3.5-turbo-0301',
    cost: {
      input: 2 / 1000000,
      output: 2 / 1000000,
    },
  },
  {
    id: 'gpt-3.5-turbo-0613',
    cost: {
      input: 1.5 / 1000000,
      output: 2 / 1000000,
    },
  },
  {
    id: 'gpt-3.5-turbo-1106',
    cost: {
      input: 1 / 1000000,
      output: 2 / 1000000,
    },
  },
];

export function calculateAzureOpenAICost(
  modelName: string,
  config: AzureOpenAiCompletionOptions,
  promptTokens?: number,
  completionTokens?: number,
): number | undefined {
  return calculateCost(
    modelName,
    { cost: undefined },
    promptTokens,
    completionTokens,
    AZURE_OPENAI_MODELS,
  );
}

export class AzureOpenAiGenericProvider implements ApiProvider {
  deploymentName: string;
  apiHost?: string;
  apiBaseUrl?: string;

  config: AzureOpenAiCompletionOptions;
  env?: EnvOverrides;

  constructor(
    deploymentName: string,
    options: { config?: AzureOpenAiCompletionOptions; id?: string; env?: EnvOverrides } = {},
  ) {
    const { config, id, env } = options;
    this.env = env;

    this.deploymentName = deploymentName;

    this.apiHost =
      config?.apiHost || env?.AZURE_OPENAI_API_HOST || getEnvString('AZURE_OPENAI_API_HOST');
    this.apiBaseUrl =
      config?.apiBaseUrl ||
      env?.AZURE_OPENAI_API_BASE_URL ||
      env?.AZURE_OPENAI_BASE_URL ||
      getEnvString('AZURE_OPENAI_API_BASE_URL') ||
      getEnvString('AZURE_OPENAI_BASE_URL');

    this.config = config || {};
    this.id = id ? () => id : this.id;
  }

  _cachedApiKey?: string;
  async getApiKey(): Promise<string> {
    if (!this._cachedApiKey) {
      if (
        this.config?.azureClientSecret &&
        this.config?.azureClientId &&
        this.config?.azureTenantId
      ) {
        const { ClientSecretCredential } = await import('@azure/identity');
        const credential = new ClientSecretCredential(
          this.config.azureTenantId,
          this.config.azureClientId,
          this.config.azureClientSecret,
          {
            authorityHost: this.config.azureAuthorityHost || 'https://login.microsoftonline.com',
          },
        );
        this._cachedApiKey = (
          await credential.getToken(
            this.config.azureTokenScope || 'https://cognitiveservices.azure.com/.default',
          )
        ).token;
      } else {
        this._cachedApiKey =
          this.config?.apiKey ||
          (this.config?.apiKeyEnvar
            ? process.env[this.config.apiKeyEnvar] ||
              this.env?.[this.config.apiKeyEnvar as keyof EnvOverrides]
            : undefined) ||
          this.env?.AZURE_OPENAI_API_KEY ||
          getEnvString('AZURE_OPENAI_API_KEY');
        if (!this._cachedApiKey) {
          throw new Error('Azure OpenAI API key must be set');
        }
      }
    }
    return this._cachedApiKey;
  }

  getApiBaseUrl(): string | undefined {
    if (this.apiBaseUrl) {
      return this.apiBaseUrl.replace(/\/$/, '');
    }
    const host = this.apiHost?.replace(/^(https?:\/\/)/, '').replace(/\/$/, '');
    if (!host) {
      return undefined;
    }
    return `https://${host}`;
  }

  id(): string {
    return `azureopenai:${this.deploymentName}`;
  }

  toString(): string {
    return `[Azure OpenAI Provider ${this.deploymentName}]`;
  }

  // @ts-ignore: Params are not used in this implementation
  async callApi(
    prompt: string,
    context?: CallApiContextParams,
    callApiOptions?: CallApiOptionsParams,
  ): Promise<ProviderResponse> {
    throw new Error('Not implemented');
  }
}

export class AzureOpenAiEmbeddingProvider extends AzureOpenAiGenericProvider {
  // TODO: remove all console.logs
  // TODO: add all logger.debug
  async callEmbeddingApi(text: string): Promise<ProviderEmbeddingResponse> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Azure OpenAI API key must be set for similarity comparison');
    }
    if (!this.getApiBaseUrl()) {
      throw new Error('Azure OpenAI API host must be set');
    }

    const body = {
      input: text,
      model: this.deploymentName,
    };

    let data,
      cached = false,
      useGateway = true;

    if (useGateway) {
      try {
        ({ data, cached } = await this.callEmbeddingApiGateway(body));
      } catch (err) {
        console.log('Error calling Azure Embedding API via Gateway: ', err);
        logger.debug(`Error calling Azure Embedding API via Gateway: ${err}`);
        useGateway = false;
      }
    }
      

    if (!useGateway) {
      try {
        ({ data, cached } = (await fetchWithCache(
          `${this.getApiBaseUrl()}/openai/deployments/${this.deploymentName}/embeddings?api-version=${
            this.config.apiVersion || '2023-12-01-preview'
          }`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api-key': apiKey,
            },
            body: JSON.stringify(body),
          },
          REQUEST_TIMEOUT_MS,
        )) as unknown as any);
      } catch (err) {
        return {
          error: `API call error: ${String(err)}`,
          tokenUsage: {
            total: 0,
            prompt: 0,
            completion: 0,
          },
        };
      }
    }
    logger.debug(`\tAzure OpenAI API response (embeddings): ${JSON.stringify(data)}`);

    try {
      const embedding = data?.data?.[0]?.embedding;
      if (!embedding) {
        throw new Error('No embedding returned');
      }
      const ret = {
        embedding,
        tokenUsage: cached
          ? { cached: data.usage.total_tokens, total: data.usage.total_tokens }
          : {
              total: data.usage.total_tokens,
              prompt: data.usage.prompt_tokens,
              completion: data.usage.completion_tokens,
            },
      };
      return ret;
    } catch (err) {
      return {
        error: `API response error: ${String(err)}: ${JSON.stringify(data)}`,
        tokenUsage: cached
          ? {
              cached: data.usage.total_tokens,
              total: data.usage.total_tokens,
            }
          : {
              total: data?.usage?.total_tokens,
              prompt: data?.usage?.prompt_tokens,
              completion: data?.usage?.completion_tokens,
            },
      };
    }
  }

  // TODO: remove all console.logs
  // TODO: add all logger.debug
  async callEmbeddingApiGateway(body: any): Promise<{ data: ProviderEmbeddingResponse; cached: boolean }> {
    try {
      const gatewayAzure = new GatewayAzure();
      const gatewayModel = gatewayAzure.embeddingModel({
        deploymentId: this.deploymentName,
        apiKey: await this.getApiKey() as string,
        baseUrl: this.getApiBaseUrl(),
      });

      console.log("body", body);
      const gatewayRequest = gatewayModel.transformModelRequest(body);
      console.log("gatewayRequest", gatewayRequest);

      const gateway = new Gateway({
        queueOptions: {
          maxConcurrentTasks: 1,
          retryCount: 4,
          retry: {
            initialDelay: getEnvInt('PROMPTFOO_REQUEST_BACKOFF_MS', 5000),
            exponentialFactor: 2,
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
      });

      const response = (await gateway.getEmbeddings({
        model: gatewayModel,
        config: gatewayRequest.config,
        embeddingRequests: gatewayRequest.embeddingRequests,
        options: {
          enableCache: isCacheEnabled(),
        }
      })) as GetEmbeddingsHandlerResponseType;
      logger.debug(`Azure OpenAI Embeddings API via Gateway response: ${JSON.stringify(response)}`);
      const gatewayResponse = response.provider.response.data;
      console.log("gatewayResponse", gatewayResponse);

      return { data: gatewayResponse, cached: response.cached };
    } catch (err) {
      logger.debug(`Error calling Azure Embedding API via Gateway: ${err}`);
      throw new Error(`Error calling Azure Embedding API via Gateway: ${err}`);
    }
  }
}

export class AzureOpenAiCompletionProvider extends AzureOpenAiGenericProvider {
  async callApi(
    prompt: string,
    context?: CallApiContextParams,
    callApiOptions?: CallApiOptionsParams,
  ): Promise<ProviderResponse> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(
        'Azure OpenAI API key is not set. Set AZURE_OPENAI_API_KEY environment variable or pass it as an argument to the constructor.',
      );
    }
    if (!this.getApiBaseUrl()) {
      throw new Error('Azure OpenAI API host must be set');
    }

    let stop: string;
    try {
      stop = getEnvString('OPENAI_STOP')
        ? JSON.parse(getEnvString('OPENAI_STOP') || '')
        : this.config?.stop || ['<|im_end|>', '<|endoftext|>'];
    } catch (err) {
      throw new Error(`OPENAI_STOP is not a valid JSON string: ${err}`);
    }
    const body = {
      model: this.deploymentName,
      prompt,
      max_tokens: this.config.max_tokens ?? getEnvInt('OPENAI_MAX_TOKENS', 1024),
      temperature: this.config.temperature ?? getEnvFloat('OPENAI_TEMPERATURE', 0),
      top_p: this.config.top_p ?? getEnvFloat('OPENAI_TOP_P', 1),
      presence_penalty: this.config.presence_penalty ?? getEnvFloat('OPENAI_PRESENCE_PENALTY', 0),
      frequency_penalty:
        this.config.frequency_penalty ?? getEnvFloat('OPENAI_FREQUENCY_PENALTY', 0),
      best_of: this.config.best_of ?? getEnvInt('OPENAI_BEST_OF', 1),
      ...(this.config.seed === undefined ? {} : { seed: this.config.seed }),
      ...(this.config.deployment_id ? { deployment_id: this.config.deployment_id } : {}),
      ...(this.config.dataSources ? { dataSources: this.config.dataSources } : {}),
      ...(this.config.response_format ? { response_format: this.config.response_format } : {}),
      ...(callApiOptions?.includeLogProbs ? { logprobs: callApiOptions.includeLogProbs } : {}),
      ...(stop ? { stop } : {}),
      ...(this.config.passthrough || {}),
    };
    logger.debug(`Calling Azure OpenAI API: ${JSON.stringify(body)}`);
    let data,
      cached = false;
    try {
      ({ data, cached } = (await fetchWithCache(
        `${this.getApiBaseUrl()}/openai/deployments/${
          this.deploymentName
        }/completions?api-version=${this.config.apiVersion || '2023-12-01-preview'}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey,
          },
          body: JSON.stringify(body),
        },
        REQUEST_TIMEOUT_MS,
      )) as unknown as any);
    } catch (err) {
      return {
        error: `API call error: ${String(err)}`,
      };
    }
    logger.debug(`\tAzure OpenAI API response: ${JSON.stringify(data)}`);
    try {
      return {
        output: data.choices[0].text,
        tokenUsage: cached
          ? { cached: data.usage.total_tokens, total: data.usage.total_tokens }
          : {
              total: data.usage.total_tokens,
              prompt: data.usage.prompt_tokens,
              completion: data.usage.completion_tokens,
            },
        cost: calculateAzureOpenAICost(
          this.deploymentName,
          this.config,
          data.usage?.prompt_tokens,
          data.usage?.completion_tokens,
        ),
      };
    } catch (err) {
      return {
        error: `API response error: ${String(err)}: ${JSON.stringify(data)}`,
      };
    }
  }
}

export class AzureOpenAiChatCompletionProvider extends AzureOpenAiGenericProvider {
  // TODO: remove all console.logs
  // TODO: add all logger.debug
  async callApi(
    prompt: string,
    context?: CallApiContextParams,
    callApiOptions?: CallApiOptionsParams,
  ): Promise<ProviderResponse> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(
        'Azure OpenAI API key is not set. Set the AZURE_OPENAI_API_KEY environment variable or add `apiKey` to the provider config.',
      );
    }
    if (!this.getApiBaseUrl()) {
      throw new Error('Azure OpenAI API host must be set');
    }

    const messages = parseChatPrompt(prompt, [{ role: 'user', content: prompt }]);

    let stop: string;
    try {
      stop = getEnvString('OPENAI_STOP')
        ? JSON.parse(getEnvString('OPENAI_STOP') || '')
        : this.config?.stop;
    } catch (err) {
      throw new Error(`OPENAI_STOP is not a valid JSON string: ${err}`);
    }
    const body = {
      model: this.deploymentName,
      messages,
      max_tokens: this.config.max_tokens ?? getEnvInt('OPENAI_MAX_TOKENS', 1024),
      temperature: this.config.temperature ?? getEnvFloat('OPENAI_TEMPERATURE', 0),
      top_p: this.config.top_p ?? getEnvFloat('OPENAI_TOP_P', 1),
      presence_penalty: this.config.presence_penalty ?? getEnvFloat('OPENAI_PRESENCE_PENALTY', 0),
      frequency_penalty:
        this.config.frequency_penalty ?? getEnvFloat('OPENAI_FREQUENCY_PENALTY', 0),
      ...(this.config.functions
        ? {
            functions: maybeLoadFromExternalFile(
              renderVarsInObject(this.config.functions, context?.vars),
            ),
          }
        : {}),
      ...(this.config.function_call ? { function_call: this.config.function_call } : {}),
      ...(this.config.seed === undefined ? {} : { seed: this.config.seed }),
      ...(this.config.tools
        ? { tools: maybeLoadFromExternalFile(renderVarsInObject(this.config.tools, context?.vars)) }
        : {}),
      ...(this.config.tool_choice ? { tool_choice: this.config.tool_choice } : {}),
      ...(this.config.deployment_id ? { deployment_id: this.config.deployment_id } : {}),
      ...(this.config.dataSources ? { dataSources: this.config.dataSources } : {}),
      ...(this.config.response_format ? { response_format: this.config.response_format } : {}),
      ...(callApiOptions?.includeLogProbs ? { logprobs: callApiOptions.includeLogProbs } : {}),
      ...(stop ? { stop } : {}),
      ...(this.config.passthrough || {}),
    };
    logger.debug(`Calling Azure OpenAI API: ${JSON.stringify(body)}`);

    let data,
      cached = false,
      useGateway = context?.gateway ? true : false;
    
    if (body.dataSources || body.function_call || this.config.passthrough) {
      // Gateway does not support dataSources, function_call, or passthrough
      useGateway = false;
    }
    
    if (useGateway) {
      try {
        console.log('Calling Azure Chat Completion via Gateway');
        ({ data, cached } = await this.callApiGateway(body, context));
        console.log('data', data);
        console.log('cached', cached);
      } catch (err) {
        console.log('Error calling Azure Chat Completion via Gateway: ', err);
        logger.debug(`Error calling Azure Chat Completion via Gateway: ${err}`);
        useGateway = false;
      }
    }

    if (!useGateway) {
      try {
        const url = this.config.dataSources
          ? `${this.getApiBaseUrl()}/openai/deployments/${
              this.deploymentName
            }/extensions/chat/completions?api-version=${
              this.config.apiVersion || '2023-12-01-preview'
            }`
          : `${this.getApiBaseUrl()}/openai/deployments/${
              this.deploymentName
            }/chat/completions?api-version=${this.config.apiVersion || '2023-12-01-preview'}`;

        ({ data, cached } = (await fetchWithCache(
          url,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api-key': apiKey,
            },
            body: JSON.stringify(body),
          },
          REQUEST_TIMEOUT_MS,
        )) as unknown as any);
      } catch (err) {
        return {
          error: `API call error: ${String(err)}`,
        };
      }
    }

    logger.debug(`\tAzure OpenAI API response: ${JSON.stringify(data)}`);
    try {
      if (data.error) {
        return {
          error: `API response error: ${data.error.code} ${data.error.message}`,
        };
      }
      const hasDataSources = !!this.config.dataSources;
      const message = hasDataSources
        ? data.choices.find(
            (choice: { message: { role: string; content: string } }) =>
              choice.message.role === 'assistant',
          )?.message
        : data.choices[0].message;
      const output =
        message.content == null
          ? message.tool_calls == null
            ? message.function_call
            : message.tool_calls
          : message.content;
      const logProbs = data.choices[0].logprobs?.content?.map(
        (logProbObj: { token: string; logprob: number }) => logProbObj.logprob,
      );
      return {
        output,
        tokenUsage: cached
          ? { cached: data.usage?.total_tokens, total: data?.usage?.total_tokens }
          : {
              total: data.usage?.total_tokens,
              prompt: data.usage?.prompt_tokens,
              completion: data.usage?.completion_tokens,
            },
        cached,
        logProbs,
        cost: calculateAzureOpenAICost(
          this.deploymentName,
          this.config,
          data.usage?.prompt_tokens,
          data.usage?.completion_tokens,
        ),
      };
    } catch (err) {
      return {
        error: `API response error: ${String(err)}: ${JSON.stringify(data)}`,
      };
    }
  }

  // TODO: remove all console.logs
  // TODO: add all logger.debug
  async callApiGateway(
    body: any,
    context?: CallApiContextParams,
  ): Promise<{ data: ProviderResponse; cached: boolean }> {
    try {
      const gatewayAzure = new GatewayAzure();
      const gatewayModel = gatewayAzure.chatModel({
        deploymentId: this.deploymentName,
        apiKey: await this.getApiKey() as string,
        baseUrl: this.getApiBaseUrl(),
      });

      console.log('body', body);
      const gatewayRequest = gatewayModel.transformModelRequest(body);
      console.log('gatewayRequest', gatewayRequest);

      console.log(`Calling Azure Chat Completion via Gateway: ${JSON.stringify(gatewayRequest)}`);
      const response = (await context?.gateway?.completeChat({
        model: gatewayModel,
        config: gatewayRequest.config,
        messages: gatewayRequest.messages,
        tools: gatewayRequest.tools,
        options: {
          enableCache: isCacheEnabled(),
        },
      })) as CompleteChatHandlerResponseType;
      console.log(`Azure Chat Completion via Gateway response: ${JSON.stringify(response)}`);
      const gatewayResponse = response.provider.response.data;
      return { data: gatewayResponse, cached: response.cached };
    } catch (err) {
      logger.debug(`Error calling Azure Chat Completion via Gateway: ${err}`);
      throw new Error(`Error calling Azure Chat Completion via Gateway: ${err}`);
    }
  }
}

type AzureOpenAiAssistantOptions = AzureOpenAiCompletionOptions &
  Partial<AssistantCreationOptions> & {
    /**
     * If set, automatically call these functions when the assistant activates
     * these function tools.
     */
    functionToolCallbacks?: Record<FunctionDefinition['name'], (arg: string) => Promise<string>>;
  };

// See https://learn.microsoft.com/en-us/javascript/api/overview/azure/openai-assistants-readme?view=azure-node-preview
export class AzureOpenAiAssistantProvider extends AzureOpenAiGenericProvider {
  assistantConfig: AzureOpenAiAssistantOptions;
  assistantsClient: AssistantsClient | undefined;
  private initializationPromise: Promise<void> | null = null;

  constructor(
    deploymentName: string,
    options: { config?: AzureOpenAiAssistantOptions; id?: string; env?: EnvOverrides } = {},
  ) {
    super(deploymentName, options);
    this.assistantConfig = options.config || {};

    this.initializationPromise = this.initialize();
  }

  async initialize() {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Azure OpenAI API key must be set');
    }

    const { AssistantsClient, AzureKeyCredential } = await import('@azure/openai-assistants');

    const apiBaseUrl = this.getApiBaseUrl();
    if (!apiBaseUrl) {
      throw new Error('Azure OpenAI API host must be set');
    }
    this.assistantsClient = new AssistantsClient(apiBaseUrl, new AzureKeyCredential(apiKey));
    this.initializationPromise = null;
  }

  async ensureInitialized() {
    if (this.initializationPromise) {
      await this.initializationPromise;
    }
  }

  async callApi(
    prompt: string,
    context?: CallApiContextParams,
    callApiOptions?: CallApiOptionsParams,
  ): Promise<ProviderResponse> {
    await this.ensureInitialized();
    invariant(this.assistantsClient, 'Assistants client not initialized');
    if (!this.getApiBaseUrl()) {
      throw new Error('Azure OpenAI API host must be set');
    }

    const assistantId = this.deploymentName;

    const assistantThread = await this.assistantsClient.createThread();
    await this.assistantsClient.createMessage(assistantThread.id, 'user', prompt);

    let run = await this.assistantsClient.createRun(assistantThread.id, {
      assistantId,
    });

    logger.debug(`\tAzure thread run API response: ${JSON.stringify(run)}`);

    while (
      run.status === 'in_progress' ||
      run.status === 'queued' ||
      run.status === 'requires_action'
    ) {
      if (run.status === 'requires_action') {
        const requiredAction = run.requiredAction;
        invariant(requiredAction, 'Run requires action but no action is provided');
        if (requiredAction === null || requiredAction.type !== 'submit_tool_outputs') {
          break;
        }
        const functionCallsWithCallbacks = requiredAction.submitToolOutputs?.toolCalls.filter(
          (toolCall) => {
            return (
              toolCall.type === 'function' &&
              toolCall.function.name in (this.assistantConfig.functionToolCallbacks ?? {})
            );
          },
        );
        if (!functionCallsWithCallbacks || functionCallsWithCallbacks.length === 0) {
          break;
        }
        logger.debug(
          `Calling functionToolCallbacks for functions: ${functionCallsWithCallbacks.map(
            ({ function: { name } }) => name,
          )}`,
        );
        const toolOutputs = await Promise.all(
          functionCallsWithCallbacks.map(async (toolCall) => {
            logger.debug(
              `Calling functionToolCallbacks[${toolCall.function.name}]('${toolCall.function.arguments}')`,
            );
            const result = await this.assistantConfig.functionToolCallbacks![
              toolCall.function.name
            ](toolCall.function.arguments);
            return {
              tool_call_id: toolCall.id,
              output: result,
            };
          }),
        );
        logger.debug(
          `Calling Azure API, submitting tool outputs for ${run.threadId}: ${JSON.stringify(
            toolOutputs,
          )}`,
        );
        run = await this.assistantsClient.submitToolOutputsToRun(run.threadId, run.id, toolOutputs);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));

      logger.debug(`Calling Azure API, getting thread run ${run.id} status`);
      run = await this.assistantsClient.getRun(run.threadId, run.id);
      logger.debug(`\tAzure thread run API response: ${JSON.stringify(run)}`);
    }

    if (run.status !== 'completed' && run.status !== 'requires_action') {
      if (run.lastError) {
        return {
          error: `Thread run failed: ${run.lastError.message}`,
        };
      }
      return {
        error: `Thread run failed: ${run.status}`,
      };
    }

    logger.debug(`Calling Azure API, getting thread run steps for ${run.threadId}`);
    const steps = await this.assistantsClient.listRunSteps(run.threadId, run.id, { order: 'asc' });
    logger.debug(`\tAzure thread run steps API response: ${JSON.stringify(steps)}`);

    const outputBlocks = [];
    for (const step of steps.data) {
      if (step.type === 'message_creation') {
        logger.debug(`Calling Azure API, getting message ${step.id}`);
        const stepDetails = step.stepDetails as RunStepMessageCreationDetails;
        // Bug in the API: the field is currently `message_id` even though it's documented as `messageId`
        const messageId =
          (stepDetails.messageCreation as any).message_id || stepDetails.messageCreation.messageId;
        const message = await this.assistantsClient.getMessage(run.threadId, messageId);
        logger.debug(`\tAzure thread run step message API response: ${JSON.stringify(message)}`);

        const content = message.content
          .map((content) =>
            content.type === 'text' ? content.text.value : `<${content.type} output>`,
          )
          .join('\n');
        outputBlocks.push(`[${toTitleCase(message.role)}] ${content}`);
      } else if (step.type === 'tool_calls') {
        for (const toolCall of (step.stepDetails as RunStepToolCallDetails).toolCalls) {
          if (toolCall.type === 'function') {
            outputBlocks.push(
              `[Call function ${toolCall.function.name} with arguments ${toolCall.function.arguments}]`,
            );
            outputBlocks.push(`[Function output: ${toolCall.function.output}]`);
          } else if (toolCall.type === 'retrieval') {
            outputBlocks.push(`[Ran retrieval]`);
          } else if (toolCall.type === 'code_interpreter') {
            const output = toolCall.codeInterpreter.outputs
              .map((output) => (output.type === 'logs' ? output.logs : `<${output.type} output>`))
              .join('\n');
            outputBlocks.push(`[Code interpreter input]`);
            outputBlocks.push(toolCall.codeInterpreter.input);
            outputBlocks.push(`[Code interpreter output]`);
            outputBlocks.push(output);
          } else {
            outputBlocks.push(`[Unknown tool call type: ${(toolCall as any).type}]`);
          }
        }
      } else {
        outputBlocks.push(`[Unknown step type: ${step.type}]`);
      }
    }

    return {
      output: outputBlocks.join('\n\n').trim(),
      /*
      tokenUsage: {
        total: data.usage.total_tokens,
        prompt: data.usage.prompt_tokens,
        completion: data.usage.completion_tokens,
      },
      */
    };
  }
}
