const { onAuthStateChanged, signInWithCustomToken, signOut } = require('firebase/auth');
const { BrowserWindow, shell } = require('electron');
const { getFirebaseAuth } = require('./firebaseClient');
const fetch = require('node-fetch');
const encryptionService = require('./encryptionService');
const migrationService = require('./migrationService');
const sessionRepository = require('../repositories/session');
const providerSettingsRepository = require('../repositories/providerSettings');
const permissionService = require('./permissionService');

const DEFAULT_SUBSCRIPTION_GATEWAY_URL = 'https://serverless-api-sf3o.vercel.app/api/virtual_key';

function getSubscriptionGatewayUrl() {
    return process.env.PICKLE_SUBSCRIPTION_GATEWAY_URL ||
        process.env.PICKLE_OPENAI_GATEWAY_URL ||
        DEFAULT_SUBSCRIPTION_GATEWAY_URL;
}

function normalizeSubscriptionResponse(json) {
    const data = json?.data || json || {};
    return {
        virtualKey: data.virtualKey || data.virtual_key || data.newVKey?.slug,
        status: data.subscriptionStatus || data.subscription_status || data.status || 'active',
        plan: data.plan || data.tier || null,
        provider: data.provider || 'openai',
    };
}

async function getSubscriptionVirtualKey(user, idToken) {
    if (!idToken) {
        throw new Error('Firebase ID token is required for subscription gateway request');
    }
    if (!user?.email) {
        throw new Error('Firebase user email is required for subscription gateway request');
    }

    const gatewayUrl = getSubscriptionGatewayUrl();
    const resp = await fetch(gatewayUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
            uid: user.uid,
            email: user.email.trim().toLowerCase(),
            provider: 'openai',
            product: 'glass-desktop',
        }),
        redirect: 'follow',
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        console.error('[SubscriptionGateway] API request failed:', json.message || json.error || 'Unknown error');
        throw new Error(json.message || json.error || `HTTP ${resp.status}: Subscription gateway request failed`);
    }

    const subscription = normalizeSubscriptionResponse(json);

    if (!subscription.virtualKey) {
        throw new Error('Subscription gateway did not return a virtual OpenAI key');
    }
    return subscription;
}

class AuthService {
    constructor() {
        this.currentUserId = 'default_user';
        this.currentUserMode = 'local'; // 'local' or 'firebase'
        this.currentUser = null;
        this.subscriptionState = {
            status: 'local',
            plan: null,
            provider: null,
            hasManagedOpenAI: false,
        };
        this.isInitialized = false;

        // This ensures the key is ready before any login/logout state change.
        this.initializationPromise = null;

        sessionRepository.setAuthService(this);
    }

    initialize() {
        if (this.isInitialized) return this.initializationPromise;

        this.initializationPromise = new Promise((resolve) => {
            const auth = getFirebaseAuth();
            onAuthStateChanged(auth, async (user) => {
                const previousUser = this.currentUser;

                if (user) {
                    // User signed IN
                    console.log(`[AuthService] Firebase user signed in:`, user.uid);
                    this.currentUser = user;
                    this.currentUserId = user.uid;
                    this.currentUserMode = 'firebase';

                    // Clean up any zombie sessions from a previous run for this user.
                    await sessionRepository.endAllActiveSessions();

                    // ** Initialize encryption key for the logged-in user if permissions are already granted **
                    if (process.platform === 'darwin' && !(await permissionService.checkKeychainCompleted(this.currentUserId))) {
                        console.warn('[AuthService] Keychain permission not yet completed for this user. Deferring key initialization.');
                    } else {
                        await encryptionService.initializeKey(user.uid);
                    }

                    // ** Check for and run data migration for the user **
                    // No 'await' here, so it runs in the background without blocking startup.
                    migrationService.checkAndRunMigration(user);

                    // ***** CRITICAL: Wait for the virtual key and model state update to complete *****
                    try {
                        const idToken = await user.getIdToken(true);
                        const subscription = await getSubscriptionVirtualKey(user, idToken);

                        if (global.modelStateService) {
                            // The model state service now writes directly to the DB, no in-memory state.
                            await global.modelStateService.setFirebaseVirtualKey(subscription.virtualKey);
                        }
                        this.subscriptionState = {
                            status: subscription.status,
                            plan: subscription.plan,
                            provider: subscription.provider,
                            hasManagedOpenAI: true,
                        };
                        console.log(`[AuthService] Managed OpenAI subscription for ${user.email} has been processed.`);

                    } catch (error) {
                        console.error('[AuthService] Failed to fetch or save subscription OpenAI key:', error);
                        this.subscriptionState = {
                            status: 'unavailable',
                            plan: null,
                            provider: 'openai',
                            hasManagedOpenAI: false,
                            error: error.message,
                        };
                        // This is not critical enough to halt the login, but we should log it.
                    }

                } else {
                    // User signed OUT
                    console.log(`[AuthService] No Firebase user.`);
                    if (previousUser) {
                        console.log(`[AuthService] Clearing API key for logged-out user: ${previousUser.uid}`);
                        if (global.modelStateService) {
                            // The model state service now writes directly to the DB.
                            await global.modelStateService.setFirebaseVirtualKey(null);
                        }
                    }
                    this.currentUser = null;
                    this.currentUserId = 'default_user';
                    this.currentUserMode = 'local';
                    this.subscriptionState = {
                        status: 'local',
                        plan: null,
                        provider: null,
                        hasManagedOpenAI: false,
                    };

                    // End active sessions for the local/default user as well.
                    await sessionRepository.endAllActiveSessions();

                    encryptionService.resetSessionKey();
                }
                this.broadcastUserState();

                if (!this.isInitialized) {
                    this.isInitialized = true;
                    console.log('[AuthService] Initialized and resolved initialization promise.');
                    resolve();
                }
            });
        });

        return this.initializationPromise;
    }

    async startFirebaseAuthFlow() {
        try {
            const webUrl = process.env.pickleglass_WEB_URL || 'http://localhost:3000';
            const authUrl = `${webUrl}/login?mode=electron`;
            console.log(`[AuthService] Opening Firebase auth URL in browser: ${authUrl}`);
            await shell.openExternal(authUrl);
            return { success: true };
        } catch (error) {
            console.error('[AuthService] Failed to open Firebase auth URL:', error);
            return { success: false, error: error.message };
        }
    }

    async signInWithCustomToken(token) {
        const auth = getFirebaseAuth();
        try {
            const userCredential = await signInWithCustomToken(auth, token);
            console.log(`[AuthService] Successfully signed in with custom token for user:`, userCredential.user.uid);
            // onAuthStateChanged will handle the state update and broadcast
        } catch (error) {
            console.error('[AuthService] Error signing in with custom token:', error);
            throw error; // Re-throw to be handled by the caller
        }
    }

    async signOut() {
        const auth = getFirebaseAuth();
        try {
            // End all active sessions for the current user BEFORE signing out.
            await sessionRepository.endAllActiveSessions();

            await signOut(auth);
            console.log('[AuthService] User sign-out initiated successfully.');
            // onAuthStateChanged will handle the state update and broadcast,
            // which will also re-evaluate the API key status.
        } catch (error) {
            console.error('[AuthService] Error signing out:', error);
        }
    }

    broadcastUserState() {
        const userState = this.getCurrentUser();
        console.log('[AuthService] Broadcasting user state change:', userState);
        BrowserWindow.getAllWindows().forEach(win => {
            if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
                win.webContents.send('user-state-changed', userState);
            }
        });
    }

    getCurrentUserId() {
        return this.currentUserId;
    }

    getCurrentUser() {
        const isLoggedIn = !!(this.currentUserMode === 'firebase' && this.currentUser);

        if (isLoggedIn) {
            return {
                uid: this.currentUser.uid,
                email: this.currentUser.email,
                displayName: this.currentUser.displayName,
                mode: 'firebase',
                isLoggedIn: true,
                subscription: this.subscriptionState,
                //////// before_modelStateService ////////
                // hasApiKey: this.hasApiKey // Always true for firebase users, but good practice
                //////// before_modelStateService ////////
            };
        }
        return {
            uid: this.currentUserId, // returns 'default_user'
            email: 'contact@pickle.com',
            displayName: 'Default User',
            mode: 'local',
            isLoggedIn: false,
            subscription: this.subscriptionState,
            //////// before_modelStateService ////////
            // hasApiKey: this.hasApiKey
            //////// before_modelStateService ////////
        };
    }
}

const authService = new AuthService();
module.exports = authService;
