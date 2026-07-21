import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    getFirestore, doc, collection,
    onSnapshot, setDoc, getDoc, getDocs,
    addDoc, updateDoc, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Projeto de produção — mesma base usada pelo painel original.
// As impressoras ficam na coleção "printers" e o link da API em system_config/api_settings.
const firebaseConfig = {
    apiKey: "AIzaSyCorudBvnvd1SmmdQeeoOzbG9MyS14oQ4Y",
    authDomain: "mapan-d4eed.firebaseapp.com",
    projectId: "mapan-d4eed",
    storageBucket: "mapan-d4eed.firebasestorage.app",
    messagingSenderId: "183188679753",
    appId: "1:183188679753:web:9329b2945e04500a356398",
    measurementId: "G-2D7SPWR7LH"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const configDocRef   = doc(db, "system_config", "api_settings");
const printersColRef = collection(db, "printers");

export {
    db, configDocRef, printersColRef,
    doc, collection,
    onSnapshot, setDoc, getDoc, getDocs,
    addDoc, updateDoc, deleteDoc, writeBatch
};
