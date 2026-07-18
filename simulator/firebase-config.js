import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

export const firebaseConfig = {
  apiKey: 'AIzaSyAxrwHnUFycTR4zyWsqC7RhwG-WWV2FyUg',
  authDomain: 'smart-home-monitor-c8015.firebaseapp.com',
  projectId: 'smart-home-monitor-c8015',
  storageBucket: 'smart-home-monitor-c8015.firebasestorage.app',
  messagingSenderId: '1024020432662',
  appId: '1:1024020432662:web:4b8b3cdd9dfab9cf84b237',
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const authReady = new Promise((resolve, reject) => {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      resolve(user);
    } else {
      signInAnonymously(auth).catch(reject);
    }
  });
});

export { db, auth, authReady };
