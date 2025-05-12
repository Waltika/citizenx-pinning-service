import Gun from 'gun';
const gun = Gun(['https://citizen-x-bootsrap.onrender.com/gun']);
gun.get('test').put({ message: 'Hello from Render bootstrap node' }, (ack) => {
    console.log('Data saved:', ack);
});