import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyB1IF4Bt_g9jOdJbssEszdeZ2-3FJ2JsPY",
    authDomain: "mapanto-3e05c.firebaseapp.com",
    projectId: "mapanto-3e05c",
    storageBucket: "mapanto-3e05c.firebasestorage.app",
    messagingSenderId: "56800934624",
    appId: "1:56800934624:web:3763334735bffd38fb6e85",
    measurementId: "G-D7GZY5QBNM"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const configDocRef = doc(db, "system_config", "api_settings");

export { db, configDocRef, onSnapshot, setDoc };