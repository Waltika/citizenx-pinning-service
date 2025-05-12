// File: ~/citizenx-pinning-service/ulvis-api-test.js
import axios from 'axios';

// Sample URL matching CitizenX sharing format
const longUrl = 'https://citizenx.app/check-extension?annotationId=did:key:z6MkvmTBYc9nKBfTteZJBFBLeq8UVb2CnNJRzyqrQXSnF1kw-1746268520959&url=https%3A%2F%2Fx.com%2FDrNeilStone%2Fstatus%2F1918363323982332114';
const customAlias = 'citizenx-test-1746268520959';

async function shortenUrl(longUrl, customAlias) {
    try {
        const apiUrl = `https://ulvis.net/API/write/get?url=${encodeURIComponent(longUrl)}&custom=${customAlias}&type=json`;
        console.log('Calling Ulvis API:', apiUrl);

        const response = await axios.get(apiUrl);
        const data = response.data;

        console.log('API Response:', data);

        if (data.success === true) {
            const shortenedUrl = data.data.url;
            console.log('Shortened URL:', shortenedUrl);
            return shortenedUrl;
        } else {
            console.error('Failed to shorten URL:', data);
            return longUrl; // Fallback to the original URL
        }
    } catch (error) {
        console.error('Error calling Ulvis API:', error.message);
        return longUrl; // Fallback to the original URL on error
    }
}

async function testShortening() {
    console.log('Testing URL shortening with Ulvis API...');
    const result = await shortenUrl(longUrl, customAlias);
    console.log('Final URL to share:', result);
}

testShortening();