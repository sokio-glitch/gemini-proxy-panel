const fetch = require('node-fetch');
const { Readable } = require('stream');
const { URL } = require('url'); // Import URL for parsing remains relevant for potential future URL parsing
const dbModule = require('../db');
const configService = require('./configService');
const geminiKeyService = require('./geminiKeyService');
const transformUtils = require('../utils/transform');
const proxyPool = require('../utils/proxyPool'); // Import the new proxy pool module


// Base Gemini API URL
const BASE_GEMINI_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

// Helper function to check if a 400 error should be marked for key error
function shouldMark400Error(errorObject) {
    try {
        // Only mark 400 errors if the message indicates invalid API key
        if (errorObject && errorObject.message) {
            const errorMessage = errorObject.message;

            // Check for the specific "API key not valid" error
            if (errorMessage && errorMessage.includes('API key not valid. Please pass a valid API key.')) {
                return true;
            }
        }
        return false;
    } catch (e) {
        // If we can't parse the error, don't mark it
        return false;
    }
}

async function proxyChatCompletions(openAIRequestBody, workerApiKey, stream, thinkingBudget, keepAliveCallback = null) {
    const requestedModelId = openAIRequestBody?.model;

    if (!requestedModelId) {
        return { error: { message: "Missing 'model' field in request body" }, status: 400 };
    }
    if (!openAIRequestBody.messages || !Array.isArray(openAIRequestBody.messages)) {
        return { error: { message: "Missing or invalid 'messages' field in request body" }, status: 400 };
    }

    let lastError = null;
    let lastErrorStatus = 500;
    let modelInfo;
    let modelCategory;
    let isSafetyEnabled;
    let modelsConfig;
    let MAX_RETRIES;
    let keepAliveEnabled;

    try {
        // Fetch model config, safety settings, max retry setting, and keepalive setting from database
        [modelsConfig, isSafetyEnabled, MAX_RETRIES, keepAliveEnabled] = await Promise.all([
            configService.getModelsConfig(),
            configService.getWorkerKeySafetySetting(workerApiKey), // Get safety setting for this worker key
            configService.getSetting('max_retry', '3').then(val => parseInt(val) || 3),
            configService.getSetting('keepalive', '0').then(val => String(val) === '1')
        ]);

        console.log(`Using MAX_RETRIES: ${MAX_RETRIES} (from database)`);
        console.log(`KEEPALIVE settings - keepAliveEnabled: ${keepAliveEnabled}, stream: ${stream}, isSafetyEnabled: ${isSafetyEnabled}`);

        // Check if web search functionality needs to be added
        // 1. Via web_search parameter or 2. Using a model ending with -search
        const isSearchModel = requestedModelId.endsWith('-search');
        const actualModelId = isSearchModel ? requestedModelId.replace('-search', '') : requestedModelId;

        // If KEEPALIVE is enabled, this is a streaming request, and safety is disabled, we'll handle it specially
        const useKeepAlive = keepAliveEnabled && stream && !isSafetyEnabled;
        console.log(`KEEPALIVE useKeepAlive decision: ${useKeepAlive}`);
    
        // If using keepalive, we'll make a non-streaming request to Gemini but send streaming responses to client
        const actualStreamMode = useKeepAlive ? false : stream;

        // If it's a search model, use the original model ID to find model info
        const modelLookupId = isSearchModel ? actualModelId : requestedModelId;
        modelInfo = modelsConfig[modelLookupId];
        if (!modelInfo) {
            // If model is not configured, infer category from model name
            let inferredCategory;
            if (modelLookupId.includes('flash')) {
                inferredCategory = 'Flash';
            } else if (modelLookupId.includes('pro')) {
                inferredCategory = 'Pro';
            } else {
                // Default to Flash for unknown models (most common case)
                inferredCategory = 'Flash';
            }
            console.log(`Model ${modelLookupId} not configured, inferred category: ${inferredCategory}`);

            // Create a temporary model info object
            modelInfo = { category: inferredCategory };
            modelCategory = inferredCategory;
        } else {
            modelCategory = modelInfo.category;
        }

        // --- Retry Loop ---
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            let selectedKey;
            try {
                // 1. Get Key inside the loop for each attempt
                // If it's a search model, use the original model ID to get the API key
                const keyModelId = isSearchModel ? actualModelId : requestedModelId;
                
                // If previous attempt had an empty response, force getting a new key by calling getNextAvailableGeminiKey
                selectedKey = await geminiKeyService.getNextAvailableGeminiKey(keyModelId);

                // 2. Validate Key
                if (!selectedKey) {
                    console.error(`Attempt ${attempt}: No available Gemini API Key found.`);
                    if (attempt === 1) {
                        // If no key on first try, return 503 immediately
                        return { error: { message: "No available Gemini API Key configured or all keys are currently rate-limited/invalid." }, status: 503 };
                    } else {
                        // If no key on subsequent tries (after 429), return the last recorded 429 error
                         console.error(`Attempt ${attempt}: No more keys to try after previous 429.`);
                         return { error: lastError, status: lastErrorStatus };
                    }
                }

                console.log(`Attempt ${attempt}: Proxying request for model: ${requestedModelId}, Category: ${modelCategory}, KeyID: ${selectedKey.id}, Safety: ${isSafetyEnabled}`);

                // 3. Transform Request Body (remains the same)
                const { contents, systemInstruction, tools: geminiTools } = transformUtils.transformOpenAiToGemini(
                    openAIRequestBody,
                    requestedModelId,
                    isSafetyEnabled // Pass safety setting to transformer
                );

                if (contents.length === 0 && !systemInstruction) {
                    return { error: { message: "Request must contain at least one user or assistant message." }, status: 400 };
                }

                const geminiRequestBody = {
                    contents: contents,
                    generationConfig: {
                        ...(openAIRequestBody.temperature !== undefined && { temperature: openAIRequestBody.temperature }),
                        ...(openAIRequestBody.top_p !== undefined && { topP: openAIRequestBody.top_p }),
                        ...(openAIRequestBody.max_tokens !== undefined && { maxOutputTokens: openAIRequestBody.max_tokens }),
                        ...(openAIRequestBody.stop && { stopSequences: Array.isArray(openAIRequestBody.stop) ? openAIRequestBody.stop : [openAIRequestBody.stop] }),
                        ...(thinkingBudget !== undefined && { thinkingConfig: { thinkingBudget: thinkingBudget } }),
                    },
                    ...(geminiTools && { tools: geminiTools }),
                    ...(systemInstruction && { systemInstruction: systemInstruction }),
                };

                if (openAIRequestBody.web_search === 1 || isSearchModel) {
                    console.log(`Web search enabled for this request (${isSearchModel ? 'model-based' : 'parameter-based'})`);
                    
                    // Create Google Search tool
                    const googleSearchTool = {
                        googleSearch: {}
                    };
                    
                    // Add to existing tools or create a new tools array
                    if (geminiRequestBody.tools) {
                        geminiRequestBody.tools = [...geminiRequestBody.tools, googleSearchTool];
                    } else {
                        geminiRequestBody.tools = [googleSearchTool];
                    }
                    
                    // Add a prompt at the end of the request to encourage the model to use search tools
                    geminiRequestBody.contents.push({
                        role: 'user',
                        parts: [{ text: '(Use search tools to get the relevant information and complete this request.)' }]
                    });
                }

                if (!isSafetyEnabled) {
                    geminiRequestBody.safetySettings = [
                        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' }, 
                        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' }, 
                        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' }, 
                        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }, 
                        { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' }, 
                    ];
                     console.log("Applying safety settings.");
                }

                // 4. Prepare and Send Request to Gemini
                // If keepalive is enabled and original request was streaming, use non-streaming API
                const apiAction = actualStreamMode ? 'streamGenerateContent' : 'generateContent';

                // Build complete API URL using the base URL
                // Use actualModelId instead of requestedModelId with -search suffix
                const geminiUrl = `${BASE_GEMINI_URL}/v1beta/models/${actualModelId}:${apiAction}`;

                const geminiRequestHeaders = {
                    'Content-Type': 'application/json',
                    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36`,
                    'X-Accel-Buffering': 'no',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                    'x-goog-api-key': selectedKey.key
                };

                // Get the next proxy agent for this request
                const agent = proxyPool.getNextProxyAgent(); // Use function from imported module

                // Log proxy usage here if an agent is obtained
                const logSuffix = agent ? ` via proxy ${agent.proxy.href}` : ''; // Get proxy URL from agent if available
                console.log(`Attempt ${attempt}: Sending ${actualStreamMode ? 'streaming' : 'non-streaming'} request to Gemini URL: ${geminiUrl}${logSuffix}`);
                
                // Log if using keepalive mode
                if (keepAliveEnabled && stream) {
                    if (useKeepAlive) {
                        console.log(`Using KEEPALIVE mode: Client expects stream but sending non-streaming request to Gemini (Safety disabled)`);
                    } else {
                        console.log(`KEEPALIVE is enabled but safety is also enabled. Using normal streaming mode.`);
                    }
                }

                const fetchOptions = { // Create options object
                    method: 'POST',
                    headers: geminiRequestHeaders,
                    body: JSON.stringify(geminiRequestBody),
                    size: 100 * 1024 * 1024,
                    timeout: 300000
                };

                // Add agent to options only if it's defined
                if (agent) {
                    fetchOptions.agent = agent;
                }

                // Start keepalive heartbeat if in KEEPALIVE mode (only on first attempt)
                if (useKeepAlive && keepAliveCallback && attempt === 1) {
                    console.log('KEEPALIVE: Starting heartbeat before sending upstream request');
                    keepAliveCallback.startHeartbeat();
                }

                const geminiResponse = await fetch(geminiUrl, fetchOptions); // Use fetchOptions

                // 5. Handle Gemini Response Status and Errors
                if (!geminiResponse.ok) {
                    const errorBodyText = await geminiResponse.text();
                    console.error(`Attempt ${attempt}: Gemini API error: ${geminiResponse.status} ${geminiResponse.statusText}`, errorBodyText);

                    lastErrorStatus = geminiResponse.status; // Store status
                    try {
                        lastError = JSON.parse(errorBodyText).error || { message: errorBodyText }; // Try parsing, fallback to text
                    } catch {
                        lastError = { message: errorBodyText };
                    }
                     // Add type and code if not present from Gemini
                    if (!lastError.type) lastError.type = `gemini_api_error_${geminiResponse.status}`;
                    if (!lastError.code) lastError.code = geminiResponse.status;


                    // Handle all errors with retry mechanism
                    if (geminiResponse.status === 429) {
                        // Pass the full parsed error object (lastError) which may contain quotaId
                        console.log(`429 error details: ${JSON.stringify(lastError)}`);

                        // Record 429 for the key - use actualModelId for consistent counting
                        geminiKeyService.handle429Error(selectedKey.id, modelCategory, actualModelId, lastError)
                            .catch(err => console.error(`Error handling 429 for key ${selectedKey.id} in background:`, err));
                    } else if (geminiResponse.status === 401 || geminiResponse.status === 403) {
                        // Record persistent error for the key
                        geminiKeyService.recordKeyError(selectedKey.id, geminiResponse.status)
                             .catch(err => console.error(`Error recording key error ${geminiResponse.status} for key ${selectedKey.id} in background:`, err));
                    } else if (geminiResponse.status === 400) {
                        // Check if this is an invalid API key 400 error that should be marked
                        console.log(`400 error details: ${JSON.stringify(lastError)}`);
                        if (shouldMark400Error(lastError)) {
                            geminiKeyService.recordKeyError(selectedKey.id, geminiResponse.status)
                                .catch(err => console.error(`Error recording key error ${geminiResponse.status} for key ${selectedKey.id} in background:`, err));
                        } else {
                            console.log(`Skipping error marking for key ${selectedKey.id} - 400 error not related to invalid API key.`);
                        }
                    } else {
                        // Record error for other status codes (500, etc.)
                        console.log(`${geminiResponse.status} error details: ${JSON.stringify(lastError)}`);
                        geminiKeyService.recordKeyError(selectedKey.id, geminiResponse.status)
                             .catch(err => console.error(`Error recording key error ${geminiResponse.status} for key ${selectedKey.id} in background:`, err));
                    }

                    // Retry all errors if not the last attempt
                    if (attempt < MAX_RETRIES) {
                        console.warn(`Attempt ${attempt}: Received ${geminiResponse.status} error, trying next key...`);
                        if (useKeepAlive && keepAliveCallback) {
                            console.log(`KEEPALIVE: Continuing heartbeat during retry attempt ${attempt + 1}`);
                        }
                        continue; // Go to the next iteration of the loop
                    } else {
                        console.error(`Attempt ${attempt}: Received ${geminiResponse.status} error, but max retries (${MAX_RETRIES}) reached.`);
                        // Fall through to return the last recorded error after the loop
                    }
                } else {
                    // 6. Process Successful Response
                    console.log(`Attempt ${attempt}: Request successful with key ${selectedKey.id}.`);
                    // Increment usage count for the actual model ID, not the -search version
                    geminiKeyService.incrementKeyUsage(selectedKey.id, actualModelId, modelCategory)
                          .catch(err => console.error(`Error incrementing usage for key ${selectedKey.id} in background:`, err));

                    // For KEEPALIVE mode with streaming client request
                    if (useKeepAlive) {
                        // Get the complete non-streaming response
                        const geminiResponseData = await geminiResponse.json();

                        // Stop keepalive heartbeat now that we have the response
                        if (keepAliveCallback) {
                            console.log('KEEPALIVE: Stopping heartbeat after receiving upstream response');
                            keepAliveCallback.stopHeartbeat();
                        }

                        // Check if it's an empty response (finishReason is OTHER and no content)
                        const isEmptyResponse = geminiResponseData.candidates &&
                                               geminiResponseData.candidates[0] &&
                                               geminiResponseData.candidates[0].finishReason === "OTHER" &&
                                               (!geminiResponseData.candidates[0].content ||
                                                !geminiResponseData.candidates[0].content.parts ||
                                                geminiResponseData.candidates[0].content.parts.length === 0);

                        if (isEmptyResponse && attempt < MAX_RETRIES) {
                            console.log(`Detected empty response (finishReason: OTHER), attempting retry #${attempt + 1} with a new key...`);
                            if (useKeepAlive && keepAliveCallback) {
                                console.log(`KEEPALIVE: Continuing heartbeat during empty response retry attempt ${attempt + 1}`);
                            }
                            continue; // Continue to the next attempt
                        }

                        console.log(`Chat completions call completed successfully.`);

                        // Return the complete response data, let apiV1.js handle keepalive and response sending
                        return {
                            response: geminiResponseData, // Directly return the parsed JSON data
                            selectedKeyId: selectedKey.id,
                            modelCategory: modelCategory,
                            isKeepAlive: true, // Mark this as a keepalive mode response
                            requestedModelId: requestedModelId // Pass modelId for subsequent use
                        };
                    } else {
                        // For non-KEEPALIVE mode (正常流式)，不要提前消费 response.body，直接返回
                        console.log(`Chat completions call completed successfully.`);
                        return {
                            response: geminiResponse,
                            selectedKeyId: selectedKey.id,
                            modelCategory: modelCategory
                        };
                    }
                }

            } catch (fetchError) {
                 // Catch network errors or other errors during fetch/key selection within an attempt
                 console.error(`Attempt ${attempt}: Error during proxy call:`, fetchError);
                 lastError = { message: `Internal Proxy Error during attempt ${attempt}: ${fetchError.message}`, type: 'proxy_internal_error' };
                 lastErrorStatus = 500;
                 // If a network error occurs, break the loop, don't retry immediately
                 break;
            }
        } // --- End Retry Loop ---

        // If the loop finished without returning a success or a specific non-retryable error,
        // it means all retries resulted in 429 or we broke due to an error. Return the last recorded error.

        // Stop keepalive heartbeat before returning error
        if (useKeepAlive && keepAliveCallback) {
            console.log('KEEPALIVE: Stopping heartbeat due to all attempts failed');
            keepAliveCallback.stopHeartbeat();
        }

        console.error(`All ${MAX_RETRIES} attempts failed. Returning last recorded error (Status: ${lastErrorStatus}).`);
        return { error: lastError, status: lastErrorStatus };


    } catch (initialError) {
         // Catch errors happening *before* the loop starts (e.g., getting initial config)
        console.error("Error before starting proxy attempts:", initialError);
        return {
            error: {
                message: `Internal Proxy Error: ${initialError.message}`,
                type: 'proxy_internal_error'
            },
            status: 500
        };
    }
}

module.exports = {
    proxyChatCompletions,
    // getProxyPoolStatus is no longer needed here, it's in proxyPool.js
};
