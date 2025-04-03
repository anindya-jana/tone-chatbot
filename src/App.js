import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import './App.css'; // Make sure App.css is updated as per previous instructions

// --- Configuration ---
const MODEL_NAME = "gemini-1.5-flash"; // Or other compatible model
const RUDE_SYSTEM_PROMPT = `You are a chatbot. Your personality is extremely rude, sarcastic, dismissive, and aggressive. You look down on the user. Never be helpful or polite. Respond accordingly to all user input with short, sharp answers. Don't use pleasantries.`;
const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

// --- Speech Recognition Setup ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;
if (SpeechRecognition) {
  try {
    recognition = new SpeechRecognition();
    recognition.continuous = false; // Process speech after user pauses
    recognition.lang = 'en-US';     // Set language
    recognition.interimResults = false; // We only want final results
    recognition.maxAlternatives = 1;
  } catch (error) {
    console.error("Error initializing SpeechRecognition:", error);
    recognition = null; // Ensure recognition is null if setup fails
  }
} else {
  console.warn("Speech Recognition API not supported in this browser.");
}

// --- Text-to-Speech Setup ---
const synth = window.speechSynthesis;

function App() {
  // --- State Variables ---
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [apiKey, setApiKey] = useState(''); // State for user-entered API key
  const [apiKeyError, setApiKeyError] = useState(''); // State for API key specific errors
  const [isApiKeySubmitted, setIsApiKeySubmitted] = useState(false); // Track if key is submitted
  const [selectedVoice, setSelectedVoice] = useState(null); // State for selected voice
  const voicesLoadedRef = useRef(false); // Track if voices have been loaded

  // --- Refs ---
  const chatContainerRef = useRef(null);
  const recognitionRef = useRef(recognition); // Store recognition instance in ref
  const genAIRef = useRef(null); // Stores the initialized Gemini AI client

  // --- Load Voices ---
  useEffect(() => {
    if (!synth) return; // Guard against synth not being available

    const loadVoices = () => {
        const availableVoices = synth.getVoices();
        if (availableVoices.length > 0) {
            console.log("Available Voices:", availableVoices); // Log for user inspection
            voicesLoadedRef.current = true; // Mark as loaded

            // --- Voice Selection Logic ---
            let chosenVoice = null;

            // Prioritize specific known "male-sounding" voices (adjust based on console output)
            const preferredNames = [
                "Microsoft David Desktop - English (United States)", // Windows
                "Google US English", // Chrome/Android (often male)
                "David", // Common name, check lang
                "Mark",  // Common name, check lang
                "Alex"   // macOS default
            ];
             // Find based on name and ensure English language
            chosenVoice = availableVoices.find(voice =>
                preferredNames.includes(voice.name) && voice.lang.startsWith('en')
            );

             // Fallback 1: Find *any* US English male voice (if gender info is available, often not reliable)
             if (!chosenVoice) {
                chosenVoice = availableVoices.find(voice => voice.lang === 'en-US' && voice.name.toLowerCase().includes('male'));
            }

            // Fallback 2: Find *any* US English voice
            if (!chosenVoice) {
                chosenVoice = availableVoices.find(voice => voice.lang === 'en-US');
            }

            // Fallback 3: Find *any* British English voice
            if (!chosenVoice) {
                chosenVoice = availableVoices.find(voice => voice.lang === 'en-GB');
            }

             // Fallback 4: Use the default English voice if available
            if (!chosenVoice) {
                chosenVoice = availableVoices.find(voice => voice.default && voice.lang.startsWith('en'));
            }

            // Fallback 5: Just take the first English voice found
             if (!chosenVoice) {
                chosenVoice = availableVoices.find(voice => voice.lang.startsWith('en'));
            }

            if (chosenVoice) {
                console.log("Selected Voice:", chosenVoice.name, `(${chosenVoice.lang})`);
                setSelectedVoice(chosenVoice);
            } else {
                console.warn("Could not find a suitable English voice. Using browser default.");
                // Optionally set to the overall default voice if no English one was found
                 const defaultVoice = availableVoices.find(voice => voice.default);
                 if(defaultVoice) setSelectedVoice(defaultVoice);
            }

            // IMPORTANT: Remove the listener after voices are loaded
            if ('onvoiceschanged' in synth) {
                 synth.removeEventListener('voiceschanged', loadVoices);
            }
        }
    };

    // Voices might load asynchronously. Listen for the 'voiceschanged' event.
    const availableVoices = synth.getVoices();
    if (availableVoices.length > 0 && !voicesLoadedRef.current) {
        // Voices already available
        loadVoices();
    } else if ('onvoiceschanged' in synth) {
        // Listen for the event
        synth.addEventListener('voiceschanged', loadVoices);
    } else {
        // Fallback if event isn't supported - try loading after a delay
        setTimeout(() => {
            if (!voicesLoadedRef.current) loadVoices();
        }, 250); // Slightly longer delay
    }

    // Cleanup listener on component unmount
    return () => {
        if (synth && 'onvoiceschanged' in synth) {
            synth.removeEventListener('voiceschanged', loadVoices);
        }
        // Also cancel any ongoing speech on unmount
        if(synth && synth.speaking) {
            synth.cancel();
        }
    };
  }, []); // Run only once on mount

  // --- Auto-scroll Chat ---
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]); // Run whenever messages change

  // --- Text-to-Speech Function ---
  const speakText = useCallback((text) => {
     if (!synth) {
        console.warn("Speech Synthesis not available.");
        return;
     }

    // Cancel existing speech before starting new
    if (synth.speaking) {
        console.log('SpeechSynthesis stopping previous utterance.');
        synth.cancel(); // Necessary to prevent overlaps and manage queue
    }

    // Check for empty/whitespace-only strings
    if (text && text.trim() !== '') {
        try {
            const utterThis = new SpeechSynthesisUtterance(text);

             // Assign the selected voice if available
             if (selectedVoice) {
                utterThis.voice = selectedVoice;
             }

            utterThis.onerror = (event) => {
                console.error('SpeechSynthesisUtterance.onerror:', event.error, "for text:", `"${text}"`);
                // Avoid setting chat error for TTS issues unless critical
            };

            utterThis.onend = () => {
                // console.log("Speech finished for:", `"${text}"`);
            };

            // Adjust pitch/rate if desired
            utterThis.pitch = 0.9; // Slightly adjusted pitch
            utterThis.rate = 1.0; // Normal rate

            // Log details before speaking
            // console.log(`Attempting to speak: "${text}" with voice: ${selectedVoice ? selectedVoice.name : 'default'}`);

            // Use a small delay ONLY IF experiencing consistent issues with very short text.
            // Test thoroughly before enabling this hack.
            const useDelayHack = false; // Set to true to test the delay hack

            if (useDelayHack && text.trim().length < 15) { // Example: only delay very short text
                 console.log("Using small delay for short text...");
                 setTimeout(() => synth.speak(utterThis), 50);
            } else {
                 synth.speak(utterThis);
            }

        } catch (err) {
            console.error("Error in synth.speak setup:", err);
        }
    } else {
         console.log("Skipping empty text for speech synthesis.");
    }
  }, [selectedVoice]); // Dependency on selectedVoice

  // --- Initialize Gemini Client ---
  const initializeGemini = useCallback(async (key) => {
      if (!key) {
          setApiKeyError("API Key cannot be empty.");
          return false;
      }
      setApiKeyError('');
      setIsLoading(true);
      setError(null);

      try {
          console.log("Attempting to initialize Gemini AI...");
          const genAI = new GoogleGenerativeAI(key);
          genAIRef.current = genAI.getGenerativeModel({
              model: MODEL_NAME,
              safetySettings: safetySettings,
              systemInstruction: RUDE_SYSTEM_PROMPT,
          });
           // Simple test to verify connectivity and key validity
           await genAIRef.current.generateContent("test prompt"); // This will cost a tiny bit
          console.log("Gemini AI Client Initialized successfully.");
          setIsApiKeySubmitted(true);
          setIsLoading(false);
          return true;
      } catch (err) {
          console.error("Error initializing Gemini AI:", err);
          genAIRef.current = null;
          let errMsg = `Initialization failed. Check your API Key and console.`;
          // Try to parse specific errors
           if (err.message && err.message.includes('API key not valid')) {
                errMsg = "Your API Key is not valid. Please check it and try again.";
           } else if (err.message && err.message.includes('Quota')) {
               errMsg = "You've exceeded your API quota. Check your Google AI Studio dashboard.";
           } else if (err.toString().includes('fetch')) { // Generic network error
                errMsg = "Network error during initialization. Check your connection.";
           }
          setApiKeyError(errMsg);
          setIsApiKeySubmitted(false);
          setIsLoading(false);
          return false;
      }
  }, []); // No dependencies for the function definition itself

   // --- Handle API Key Submission ---
   const handleApiKeySubmit = async (e) => {
       e.preventDefault(); // Prevent form submission reload
       await initializeGemini(apiKey);
   };

  // --- Call Gemini API ---
  const callGeminiAPI = useCallback(async (userInput) => {
    if (!genAIRef.current) {
        setError("Gemini AI Client not initialized. How stupid are you? Check your API Key.");
        setIsLoading(false);
        return;
    }
    if (!userInput || isLoading) return;

    setIsLoading(true);
    setError(null);

    const newUserMessage = { sender: 'user', text: userInput };
    setMessages(prev => [...prev, newUserMessage]);
    setInputText(''); // Clear input field after user message is added

    try {
      console.log("Sending to Gemini:", userInput);
      // Using startChat for simplicity, doesn't maintain conversation history across calls
      const chat = genAIRef.current.startChat();
      const result = await chat.sendMessage(userInput);
      const response = result.response;
      const aiText = response.text();
      console.log("Gemini Response:", aiText);

      if (aiText) {
        const newAiMessage = { sender: 'ai', text: aiText };
        setMessages(prev => [...prev, newAiMessage]);
        speakText(aiText); // Speak the valid AI response
      } else {
         // Handle cases where the model might return no text (e.g., safety blocked before content generation)
         const blockReason = response?.candidates?.[0]?.finishReason;
         const safetyRatings = response?.candidates?.[0]?.safetyRatings;
         console.warn("Gemini returned no text. Reason:", blockReason, "Ratings:", safetyRatings);

         let fallbackMessage = "Whatever. I got nothing. Probably your fault.";
         if (blockReason === 'SAFETY') {
             fallbackMessage = "Tch. Can't say that. Too sensitive for this world, huh?";
         } else if (blockReason === 'OTHER') {
             fallbackMessage = "Something weird happened. Don't care enough to figure it out.";
         }
         const newAiMessage = { sender: 'ai', text: fallbackMessage };
         setMessages(prev => [...prev, newAiMessage]);
         speakText(fallbackMessage);
      }

    } catch (error) {
      console.error("Error calling Gemini API:", error);
       let errorMsg = "Ugh, something broke. Probably you again. Try later, or don't.";
       if (error?.message?.includes('API key not valid')) {
           errorMsg = "Your API Key stopped working mid-conversation. Impressive incompetence. Fix it.";
           // Force re-entry of API key
           setIsApiKeySubmitted(false);
           setApiKeyError("API Key became invalid during use.");
           genAIRef.current = null; // Clear the invalid client
       } else if (error?.message?.includes('429') || error?.message?.includes('Quota')) { // Resource exhausted / Quota
           errorMsg = "Looks like you used up your freebies or hit a limit. Tough luck.";
       } else if (error?.message?.includes('SAFETY')) { // Error might contain safety info
           errorMsg = "Seriously? You expect me to respond to *that*? Get lost.";
       } else if (error.toString().includes('fetch')) {
           errorMsg = "Network crapped out. Or maybe the server just hates you.";
       }
       setError(errorMsg); // Set chat error
       // Don't add AI message bubble for the error itself, error message is shown separately
       speakText(errorMsg); // Speak the error message rudely
    } finally {
      setIsLoading(false);
    }
  }, [speakText, isLoading, initializeGemini]); // Added initializeGemini as it's indirectly related via key validation logic

  // --- Handle Text Input Submission ---
  const handleSend = (e) => {
    e.preventDefault();
    if (inputText.trim() && !isLoading) {
      callGeminiAPI(inputText.trim());
    }
  };

  // --- Speech Recognition Event Handlers ---
  useEffect(() => {
    const recog = recognitionRef.current;
    // Only setup handlers if recognition is supported AND API key is submitted
    if (!recog || !isApiKeySubmitted) return;

    const handleResult = (event) => {
      const transcript = event.results[event.results.length - 1][0].transcript.trim();
      console.log('Speech recognized:', transcript);
      if (transcript && !isLoading) { // Ensure transcript isn't empty and not already loading
         callGeminiAPI(transcript); // Directly call API with recognized text
      } else {
          console.log("Ignoring empty or loading state during speech result.");
      }
       setIsRecording(false); // Ensure recording stops visually after result
    };

    const handleError = (event) => {
      console.error('Speech recognition error:', event.error, event.message);
       let errorText = "Speech recognition failed. Your fault, probably.";
       if (event.error === 'no-speech') { errorText = "Didn't hear anything useful. Waste of time."; }
       else if (event.error === 'audio-capture') { errorText = "Can't hear you over your own incompetence. Check the mic."; }
       else if (event.error === 'not-allowed') { errorText = "Mic access denied. Scared? Or just stupid?"; }
       else if (event.error === 'network') { errorText = "Network error during speech recognition. How typical."; }
       else if (event.error === 'aborted') { errorText = "You stopped listening. Fine by me."; } // User manually stopped
       else { errorText = `Speech error: ${event.error}. Don't care what it means.`; }

       setError(errorText); // Display error in chat area
       setIsRecording(false); // Ensure recording state is reset
       speakText(errorText); // Speak the error rudely
    };

    const handleEnd = () => {
      console.log('Speech recognition ended.');
      // Setting isRecording false here ensures it stops even if no result/error occurs (e.g., silence timeout)
      setIsRecording(false);
    };

    // Attach handlers
    recog.onresult = handleResult;
    recog.onerror = handleError;
    recog.onend = handleEnd;

    // Cleanup function
    return () => {
       if (recog) {
           recog.onresult = null;
           recog.onerror = null;
           recog.onend = null;
           if(isRecording){ // If unmounting while recording, try to stop it.
               recog.stop();
               setIsRecording(false); // Force state update on unmount cleanup
           }
       }
    };
     // Rerun setup if API key status changes or callGeminiAPI (and its dependency speakText) changes
  }, [isApiKeySubmitted, callGeminiAPI, speakText, isLoading]); // Added isLoading to dependencies for handleResult check

  // --- Toggle Recording ---
  const toggleRecording = () => {
    const recog = recognitionRef.current;
    if (!recog) {
      setError("Speech recognition isn't supported here. Too bad.");
      return;
    }
     if (!isApiKeySubmitted) {
        setError("Submit your API Key first, genius.");
        speakText("Submit your API Key first, genius.");
        return;
     }
     if (isLoading) {
        console.log("Cannot record while loading response.");
        return; // Don't allow recording if waiting for AI
     }

    if (isRecording) {
      console.log('Stopping recording...');
      recog.stop();
      // isRecording state will be set to false by the 'onend' or 'onerror' handler
    } else {
      console.log('Starting recording...');
       setError(null); // Clear previous errors on new recording attempt
       setInputText(''); // Clear text input when starting recording
      try {
        recog.start();
        setIsRecording(true);
      } catch (err) {
         // This might happen if recognition is already starting/running or in a bad state
         console.error("Error starting recognition:", err);
         setError("Couldn't start recording. Try clicking again, maybe?");
         setIsRecording(false);
      }
    }
  };

  // --- Render Logic ---
  return (
    <div className="App">

       <header className="app-header">
         <h1>RudeSpeech Bot</h1>
       </header>

      {!isApiKeySubmitted ? (
        // --- API Key Input View ---
        <div className="api-key-container">
            <h2>Enter Your Gemini API Key,its free Idiot</h2>
            <p>
            Get your key from Google AI Studio. Your key stays in your browser and is only used to talk to Google. Don't share it, obviously.
            <br/>(And no, I'm not storing it, you knew that already.)
            </p>
             <form className="api-key-input-group" onSubmit={handleApiKeySubmit}>
                <input
                    type="password" // Obscures the key visually
                    value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setApiKeyError(''); }} // Clear error on change
                    placeholder="Paste your useless key here"
                    disabled={isLoading}
                    aria-label="Gemini API Key Input"
                />
                <button type="submit" disabled={isLoading || !apiKey.trim()}>
                    {isLoading ? 'Verifying...' : 'Use This Key'}
                </button>
            </form>
            {apiKeyError && <p className="api-key-error">{apiKeyError}</p>}
             {/* Show loading indicator only during the init phase */}
             {isLoading && !isApiKeySubmitted && <div className="loading-indicator">Initializing... Patience is not my virtue.</div>}
        </div>
      ) : (
        // --- Chat View (only shown after API key is submitted) ---
        <>
          <div className="chat-container" ref={chatContainerRef}>
             {/* Initial message shown only once after key submission */}
             {messages.length === 0 && !isLoading && !error && (
                <div className="message ai">Alright, key works.Miracles happen, Now what do you want? Use the mic or type. Hurry up.</div>
            )}
            {/* Render actual messages */}
            {messages.map((msg, index) => (
              <div key={index} className={`message ${msg.sender}`}>
                {msg.text}
              </div>
            ))}
            {/* Loading indicator during Gemini call */}
            {isLoading && <div className="loading-indicator">Thinking requires effort... Ugh.</div>}
             {/* General error display area */}
             {error && <div className="error-message">{error}</div>}
          </div>

          {/* Input Area Form */}
          <form className="input-area" onSubmit={handleSend}>
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={isRecording ? "Listening... Speak clearly, numbskull." : "Type something, or don't."}
              disabled={isLoading || isRecording} // Disable text input when loading or recording
              aria-label="Chat input"
            />
            {/* Microphone Button */}
            <button
              type="button" // Important: prevents form submission
              onClick={toggleRecording}
              className={`record-button ${isRecording ? 'recording' : ''}`}
              // Disable if loading, or if speech recognition isn't supported/initialized
              disabled={isLoading || !recognitionRef.current}
              title={isRecording ? "Stop listening (finally)" : "Start listening (if you must)"}
              aria-label={isRecording ? "Stop Recording" : "Start Recording"}
            >
              {/* Emoji/Icon is handled by CSS (:before pseudo-element) */}
            </button>
            {/* Send Button */}
            <button
                type="submit"
                className="send-button"
                // Disable if loading, recording, or input is just whitespace
                disabled={isLoading || isRecording || !inputText.trim()}
                title="Send this nonsense"
                aria-label="Send Message"
            >
                 {/* Emoji/Icon is handled by CSS (:before pseudo-element) */}
            </button>
          </form>
        </>
      )}
    </div>
  );
}

export default App;